import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { DB } from "./db.js";
import type { RawSymbol, StructuralResult } from "../ingest/structural.js";

export function toRelPath(repoRoot: string, absPath: string): string {
  return relative(repoRoot, absPath).split(/[\\/]/).join("/");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type EdgeKind =
  | "IMPORTS"
  | "DECLARES"
  | "CALLS"
  | "REFERENCES"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "HANDLES";

export interface EdgeRow {
  src: string;
  dst: string;
  kind: EdgeKind;
  resolution: "resolved" | "heuristic";
  file: string;
  line: number;
}

export type UnresolvedKind = "import" | "call" | "heritage" | "reference";

export interface UnresolvedRow {
  nodeId: string;
  kind: UnresolvedKind;
  text: string;
  file: string;
  line: number;
}

export function nodeId(kind: string, qualifiedName: string): string {
  return `${kind}:${qualifiedName}`;
}

export function moduleNodeId(relPath: string): string {
  return nodeId("module", relPath);
}

function qualifiedName(relPath: string, sym: RawSymbol): string {
  return sym.kind === "method" && sym.container
    ? `${relPath}:${sym.container}.${sym.name}`
    : `${relPath}:${sym.name}`;
}

const INSERT_EDGE_SQL = `
  INSERT INTO edges (src, dst, kind, resolution, file, line)
  VALUES (@src, @dst, @kind, @resolution, @file, @line)
  ON CONFLICT(src, dst, kind) DO UPDATE SET
    resolution = excluded.resolution, file = excluded.file, line = excluded.line`;

export interface PersistInput {
  relPath: string;
  hash: string;
  mtimeMs: number;
  structural: StructuralResult;
}

/** Replace all rows for each file: files row, module node, symbol nodes, DECLARES edges. */
export function persistFiles(db: DB, inputs: PersistInput[]): void {
  const upsertFile = db.prepare(
    `INSERT INTO files(path, hash, mtime, parsed_at)
     VALUES(@path, @hash, @mtime, @parsed_at)
     ON CONFLICT(path) DO UPDATE SET
       hash = excluded.hash, mtime = excluded.mtime, parsed_at = excluded.parsed_at`,
  );
  const clearFileNodes = db.prepare(`DELETE FROM nodes WHERE file = ?`);
  const insertNode = db.prepare(
    `INSERT OR REPLACE INTO nodes
       (id, kind, name, qualified_name, file, span_start, span_end, signature, doc, exported)
     VALUES (@id, @kind, @name, @qualified_name, @file, @span_start, @span_end, @signature, @doc, @exported)`,
  );
  const insertEdge = db.prepare(INSERT_EDGE_SQL);

  const run = db.transaction((rows: PersistInput[]) => {
    const now = Date.now();
    for (const { relPath, hash, mtimeMs, structural } of rows) {
      clearFileNodes.run(relPath);
      upsertFile.run({
        path: relPath,
        hash,
        mtime: Math.trunc(mtimeMs),
        parsed_at: now,
      });

      const modId = moduleNodeId(relPath);
      insertNode.run({
        id: modId,
        kind: "module",
        name: relPath.split("/").pop() ?? relPath,
        qualified_name: relPath,
        file: relPath,
        span_start: 0,
        span_end: 0,
        signature: null,
        doc: null,
        exported: 0,
      });

      for (const sym of structural.symbols) {
        const qn = qualifiedName(relPath, sym);
        const id = nodeId(sym.kind, qn);
        insertNode.run({
          id,
          kind: sym.kind,
          name: sym.name,
          qualified_name: qn,
          file: relPath,
          span_start: sym.spanStart,
          span_end: sym.spanEnd,
          signature: sym.signature,
          doc: sym.doc ?? null,
          exported: sym.exported ? 1 : 0,
        });
        insertEdge.run({
          src: modId,
          dst: id,
          kind: "DECLARES",
          resolution: "resolved",
          file: relPath,
          line: 1,
        });
      }
    }
  });

  run(inputs);
}

/** Generic edge upsert — IMPORTS now, CALLS/EXTENDS/etc. later. */
export function persistEdges(db: DB, rows: EdgeRow[]): void {
  const insert = db.prepare(INSERT_EDGE_SQL);
  const run = db.transaction((es: EdgeRow[]) => {
    for (const e of es) insert.run(e);
  });
  run(rows);
}

export function persistUnresolved(db: DB, rows: UnresolvedRow[]): void {
  const insert = db.prepare(
    `INSERT INTO unresolved (node_id, kind, text, file, line)
     VALUES (@node_id, @kind, @text, @file, @line)`,
  );
  const run = db.transaction((rs: UnresolvedRow[]) => {
    for (const r of rs) {
      insert.run({
        node_id: r.nodeId,
        kind: r.kind,
        text: r.text,
        file: r.file,
        line: r.line,
      });
    }
  });
  run(rows);
}
