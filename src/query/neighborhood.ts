import { openDB } from "../store/db.js";
import { LineResolver } from "./lines.js";

export type Direction = "upstream" | "downstream" | "both";

export interface NeighborhoodNode {
	id: string;
	kind: string;
	name: string;
	qualifiedName: string;
	file: string;
	signature: string | null;
	doc: string | null;
	depth: number; // hops from seed; 0 = seed
	spanStart: number;
	line: number;
	churn: number; // commits touching this node's file (0 if no git data)
}

export interface NeighborhoodEdge {
	src: string;
	dst: string;
	kind: string;
	resolution: string;
	file: string;
	line: number;
}

export interface UnresolvedInScope {
	nodeId: string;
	kind: string;
	text: string;
	file: string;
	line: number;
}

export interface Neighborhood {
	seed: NeighborhoodNode;
	nodes: NeighborhoodNode[]; // includes the seed
	edges: NeighborhoodEdge[]; // induced subgraph: both endpoints in `nodes`
	unresolvedInScope: UnresolvedInScope[];
	truncated: boolean; // set later by the serializer's budget/degradation
}

interface NodeRow {
	id: string;
	kind: string;
	name: string;
	qualified_name: string;
	file: string;
	span_start: number;
	signature: string | null;
	doc: string | null;
}

export function getNeighborhood(
	repoRoot: string,
	seedId: string,
	depth: number,
	direction: Direction,
): Neighborhood {
	const maxDepth = Math.min(Math.max(Math.trunc(depth), 0), 3); // FR-SLICE-2 hard cap
	const down = direction === "downstream" || direction === "both" ? 1 : 0;
	const up = direction === "upstream" || direction === "both" ? 1 : 0;

	const db = openDB(repoRoot);
	try {
		if (!db.prepare(`SELECT 1 FROM nodes WHERE id = ?`).get(seedId)) {
			throw new Error(`no node with id: ${seedId}`);
		}

		/**Walk up to maxDepth hops. DECLARES is structural (module->symbol) and would
    pull in whole modules, so it's not traversable. */
		const reached = db
			.prepare(
				`WITH RECURSIVE reach(id, depth) AS (
           SELECT @seed, 0
           UNION
           SELECT CASE WHEN e.src = r.id THEN e.dst ELSE e.src END, r.depth + 1
           FROM reach r
           JOIN edges e
             ON ((@down = 1 AND e.src = r.id) OR (@up = 1 AND e.dst = r.id))
           WHERE r.depth < @maxDepth AND e.kind <> 'DECLARES'
         )
         SELECT id, MIN(depth) AS depth FROM reach GROUP BY id`,
			)
			.all({ seed: seedId, down, up, maxDepth }) as {
			id: string;
			depth: number;
		}[];

		const depthById = new Map(reached.map((r) => [r.id, r.depth]));
		const idJson = JSON.stringify([...depthById.keys()]);

		const nodeRows = db
			.prepare(
				`SELECT id, kind, name, qualified_name, file, span_start, signature, doc
         FROM nodes WHERE id IN (SELECT value FROM json_each(?))`,
			)
			.all(idJson) as NodeRow[];

		const lines = new LineResolver(repoRoot);

		const edges = db
			.prepare(
				`SELECT src, dst, kind, resolution, file, line FROM edges
         WHERE kind <> 'DECLARES'
           AND src IN (SELECT value FROM json_each(@ids))
           AND dst IN (SELECT value FROM json_each(@ids))`,
			)
			.all({ ids: idJson }) as NeighborhoodEdge[];

		const unresolvedInScope = db
			.prepare(
				`SELECT node_id AS nodeId, kind, text, file, line
         FROM unresolved WHERE node_id IN (SELECT value FROM json_each(?))`,
			)
			.all(idJson) as UnresolvedInScope[];

		const churnByFile = new Map(
			(
				db.prepare(`SELECT path, commits FROM file_churn`).all() as {
					path: string;
					commits: number;
				}[]
			).map((r) => [r.path, r.commits]),
		);

		const nodes: NeighborhoodNode[] = nodeRows
			.map((n) => ({
				id: n.id,
				kind: n.kind,
				name: n.name,
				qualifiedName: n.qualified_name,
				file: n.file,
				signature: n.signature,
				doc: n.doc,
				depth: depthById.get(n.id) ?? 0,
				spanStart: n.span_start,
				line: lines.lineAt(n.file, n.span_start),
				churn: churnByFile.get(n.file) ?? 0,
			}))
			.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));

		const seed = nodes.find((n) => n.id === seedId)!;
		return { seed, nodes, edges, unresolvedInScope, truncated: false };
	} finally {
		db.close();
	}
}
