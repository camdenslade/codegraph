import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { DB } from "./db.js";
import type { RawSymbol, StructuralResult } from "../ingest/structural.js";

/** Repo-relative, forward-slash-separated path. */
export function toRelPath(repoRoot: string, absPath: string): string {
    return relative(repoRoot, absPath).split(/[\\]/).join("/");
}

export function hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function nodeId(kind: string, qualifiedName: string): string {
    return `${kind}:${qualifiedName}`;
}

function qualifiedName(relPath: string, sym: RawSymbol): string {
    return sym.kind === "method" && sym.container
        ? `${relPath}:${sym.container}.${sym.name}`
        : `${relPath}:${sym.name}`;
}

export interface PersistInput {
    relPath: string;
    hash: string;
    mtimeMs: number;
    structural: StructuralResult;
}

/** Replace every row belonging to each given file with freshly parsed data */
export function persistFiles(db: DB, inputs: PersistInput[]): void {
    const upsertFile = db.prepare(
        `INSERT INTO files (path, hash, mtime, parsed_at)
        VALUES(@path, @hash, @mtime, @parsed_at)
        ON CONFLICT(path) DO UPDATE SET
            hash = excluded.hash, mtime = excluded.mtime, parsed_at = excluded.parsed_at`,
    );
    const clearFileNodes = db.prepare(`DELETE FROM nodes WHERE file = ?`);
    const insertNode = db.prepare(
        `INSERT OR REPLACE INTO nodes
        (id, kind, name, qualified_name, file, span_start, span_end, signature, doc)
        VALUES (@id, @kind, @name, @qualified_name, @file, @span_start, @span_end, @signature, @doc)`,
    );

    const run = db.transaction((rows: PersistInput[]) => {
        const now = Date.now();
        for (const { relPath, hash, mtimeMs, structural } of rows) {
            clearFileNodes.run(relPath); // FK cascade also clears
            upsertFile.run({
                path: relPath,
                hash,
                mtime: Math.trunc(mtimeMs),
                parsed_at: now,
            });

            insertNode.run({
                id: nodeId("module", relPath),
                kind: "module",
                name: relPath.split("/").pop() ?? relPath,
                qualified_name: relPath,
                file: relPath,
                span_start: 0,
                span_end: 0,
                signature: null,
                doc: null,
            });

            for (const sym of structural.symbols) {
                const qn = qualifiedName(relPath, sym);
                insertNode.run({
                    id: nodeId(sym.kind, qn),
                    kind: sym.kind,
                    name: sym.name,
                    qualified_name: qn,
                    file: relPath,
                    span_start: sym.spanStart,
                    span_end: sym.spanEnd,
                    signature: sym.signature,
                    doc: sym.doc ?? null,
                });
            }
        }
    });

    run(inputs);
}