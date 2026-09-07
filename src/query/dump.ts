import { openDB } from "../store/db.js";

export interface GraphDump {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
    unresolved: Record<string, unknown>[];
}

/** Stable, timestamp-free snapshot of the graph for golden tests (NFR-5). */
export function dumpGraph(repoRoot: string): GraphDump {
    const db = openDB(repoRoot);
    try {
        return {
            nodes: db
                .prepare(
                    `SELECT id, kind, name, qualified_name, file, span_start, span_end,
                    signature, doc, exported
                    FROM nodes ORDER BY id`
                )
                .all() as Record<string, unknown>[],
            edges: db
                .prepare(
                    `SELECT src, dst, kind, resolution, file, line
                    FROM edges ORDER BY src, dst, kind`
                )
                .all() as Record<string, unknown>[],
            unresolved: db
                .prepare(
                    `SELECT node_id, kind, text, file, line
                    FROM unresolved ORDER BY node_id, kind, text, line`
                )
                .all() as Record<string, unknown>[]
        };
    } finally {
        db.close();
    }
}