import type { DB } from "../store/db.js";
import { openDB } from "../store/db.js";
import { LineResolver } from "./lines.js";

export interface PathStep {
  from: string;
  to: string;
  kind: string;
  at: string; // file:line
}

export interface PathNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  location: string;
}

export interface FindPathResult {
  found: boolean;
  length: number; // edge count; 0 when from === to
  nodes: PathNode[]; // ordered from -> to
  steps: PathStep[];
  maxLen: number;
  message?: string;
}

export function findPath(
  repoRoot: string,
  fromId: string,
  toId: string,
  maxLen = 8,
): FindPathResult {
  const db = openDB(repoRoot);
  try {
    const exists = db.prepare(`SELECT 1 FROM nodes WHERE id = ?`);
    if (!exists.get(fromId)) throw new Error(`no node with id: ${fromId}`);
    if (!exists.get(toId)) throw new Error(`no node with id: ${toId}`);

    if (fromId === toId) {
      return {
        found: true,
        length: 0,
        nodes: hydrate(db, repoRoot, [fromId]),
        steps: [],
        maxLen,
      };
    }

    const rows = db
      .prepare(
        `SELECT src, dst, kind, file, line FROM edges
         WHERE kind IN ('CALLS', 'HANDLES', 'IMPORTS')`,
      )
      .all() as {
      src: string;
      dst: string;
      kind: string;
      file: string;
      line: number;
    }[];

    const adj = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) {
      const list = adj.get(r.src) ?? [];
      list.push(r);
      adj.set(r.src, list);
    }

    // BFS: first discovery of a node is a shortest path to it.
    const prev = new Map<
      string,
      { via: string; kind: string; file: string; line: number }
    >();
    const dist = new Map<string, number>([[fromId, 0]]);
    const queue = [fromId];
    let head = 0;
    let hit = false;

    while (head < queue.length && !hit) {
      const cur = queue[head++]!;
      const d = dist.get(cur)!;
      if (d >= maxLen) continue;
      for (const e of adj.get(cur) ?? []) {
        if (dist.has(e.dst)) continue;
        dist.set(e.dst, d + 1);
        prev.set(e.dst, { via: cur, kind: e.kind, file: e.file, line: e.line });
        if (e.dst === toId) {
          hit = true;
          break;
        }
        queue.push(e.dst);
      }
    }

    if (!hit) {
      return {
        found: false,
        length: 0,
        nodes: [],
        steps: [],
        maxLen,
        message: `no directed path from ${fromId} to ${toId} within ${maxLen} hops (CALLS/HANDLES/IMPORTS)`,
      };
    }

    const idChain: string[] = [toId];
    const steps: PathStep[] = [];
    for (let node = toId; node !== fromId; ) {
      const p = prev.get(node)!;
      steps.push({ from: p.via, to: node, kind: p.kind, at: `${p.file}:${p.line}` });
      idChain.push(p.via);
      node = p.via;
    }
    idChain.reverse();
    steps.reverse();

    return {
      found: true,
      length: steps.length,
      nodes: hydrate(db, repoRoot, idChain),
      steps,
      maxLen,
    };
  } finally {
    db.close();
  }
}

function hydrate(db: DB, repoRoot: string, ids: string[]): PathNode[] {
  const lines = new LineResolver(repoRoot);
  const stmt = db.prepare(
    `SELECT id, kind, name, qualified_name, file, span_start FROM nodes WHERE id = ?`,
  );
  return ids.map((id) => {
    const r = stmt.get(id) as {
      id: string;
      kind: string;
      name: string;
      qualified_name: string;
      file: string;
      span_start: number;
    };
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      qualifiedName: r.qualified_name,
      location: `${r.file}:${lines.lineAt(r.file, r.span_start)}`,
    };
  });
}
