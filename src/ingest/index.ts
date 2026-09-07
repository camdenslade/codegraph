import { readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { openDB } from "../store/db.js";
import {
  hashText,
  persistFiles,
  toRelPath,
  type PersistInput,
} from "../store/persist.js";
import { discoverFiles } from "./discover.js";
import { structuralParse } from "./structural.js";

export interface IngestOptions {
    fresh?: boolean;
}

export interface IngestReport {
    repoRoot: string;
    filesDiscovered: number;
    filesParsed: number;
    filesErrored: number;
    nodeCount: number;
    elapsedMs: number;
}

export function ingest(repoRoot: string, opts: IngestOptions = {}): IngestReport {
    const start = performance.now();
    const { repoRoot: root, files } = discoverFiles(repoRoot);
    const db = openDB(root, { fresh: opts.fresh ?? false });

    const inputs: PersistInput[] = [];
    const errors: { file: string; message: string }[] = [];
    for (const abs of files) {
        const relPath = toRelPath(root, abs);
        try {
            const source = readFileSync(abs, "utf-8");
            const mtimeMs = statSync(abs).mtimeMs;
            const structural = structuralParse(relPath, source);
            inputs.push({ relPath, hash: hashText(source), mtimeMs, structural });
        } catch (err) {
            errors.push({ file: relPath, message: (err as Error).message });
        }
    }  

    persistFiles(db, inputs);

    const recordErrors = db.transaction(() => {
        const clear = db.prepare(`DELETE FROM parse_errors WHERE file = ?`);
        const insert = db.prepare(`INSERT INTO parse_errors (file, message) VALUES (?, ?)`);
        const now = Date.now();
        for (const e of errors) {
            clear.run(e.file);
            insert.run(e.file, e.message, now);
        }
    });
    recordErrors();

    const elapsedMs = Math.round(performance.now() - start);
    const inputSetHash = hashText(
        inputs
            .map((i) => `${i.relPath}:${i.hash}`)
            .sort()
            .join("\n"),
    );

    const setMeta = db.prepare(
        `INSERT INTO meta(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    setMeta.run("repo_root", root);
    setMeta.run("input_set_hash", inputSetHash);
    setMeta.run("ingested_at", String(Date.now()));
    setMeta.run("ingest_ms", String(elapsedMs));

    const nodeCount = (
        db.prepare(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }
    ).n;

    db.close();

    return {
        repoRoot: root,
        filesDiscovered: files.length,
        filesParsed: inputs.length,
        filesErrored: errors.length,
        nodeCount,
        elapsedMs,
    };
}