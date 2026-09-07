import { openDB } from "../store/db.js";

export interface Stats {
	repoRoot: string;
	nodesByKind: Record<string, number>;
	edgesByKind: Record<string, number>;
	nodeTotal: number;
	edgeTotal: number;
	resolvedEdges: number;
	heuristicEdges: number;
	unresolvedCount: number;
	unresolvedByKind: Record<string, number>;
	/** resolved / (resolved + heuristic + unresolved); null when there are no edges yet. SC-3 */
	resolutionRate: number | null;
	parseErrors: number;
	ingestMs: number | null;
	ingestedAt: number | null;
	callsResolved: number;
	callsHeuristic: number;
	callsUnresolved: number; // unresolved rows with kind = 'call'
	callResolutionRate: number | null; // SC-3: resolved / (resolved + unresolved)
}

export function getStats(repoRoot: string): Stats {
	const db = openDB(repoRoot);
	try {
		const nodesByKind = groupCount(
			db,
			`SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind`,
		);
		const edgesByKind = groupCount(
			db,
			`SELECT kind, COUNT(*) AS n FROM edges GROUP BY kind`,
		);
		const nodeTotal = scalar(db, `SELECT COUNT(*) AS n FROM nodes`);
		const edgeTotal = scalar(db, `SELECT COUNT(*) AS n FROM edges`);
		const resolvedEdges = scalar(
			db,
			`SELECT COUNT(*) AS n FROM edges WHERE resolution = 'resolved'`,
		);
		const heuristicEdges = scalar(
			db,
			`SELECT COUNT(*) AS n FROM edges WHERE resolution = 'heuristic'`,
		);
		const unresolvedCount = scalar(
			db,
			`SELECT COUNT(*) AS n FROM unresolved`,
		);
		const unresolvedByKind = groupCount(
			db,
			`SELECT kind, COUNT(*) AS n FROM unresolved GROUP BY kind`,
		);
		const parseErrors = scalar(
			db,
			`SELECT COUNT(*) AS n FROM parse_errors`,
		);
		const callsResolved = scalar(
			db,
			`SELECT COUNT(*) AS n FROM edges WHERE kind = 'CALLS' AND resolution = 'resolved'`,
		);
		const callsHeuristic = scalar(
			db,
			`SELECT COUNT(*) AS n FROM edges WHERE kind = 'CALLS' AND resolution = 'heuristic'`,
		);
		const callsUnresolved = scalar(
			db,
			`SELECT COUNT(*) AS n FROM unresolved WHERE kind = 'call'`,
		);
		const callDenominator = callsResolved + callsUnresolved;
		const callResolutionRate =
			callDenominator === 0 ? null : callsResolved / callDenominator;

		const denominator = resolvedEdges + heuristicEdges + unresolvedCount;
		// gives us res rate if denominator is not 0 or null
		const resolutionRate =
			denominator === 0 ? null : resolvedEdges / denominator;

		const ingestMs = numMeta(db, "ingest_ms");
		const ingestedAt = numMeta(db, "ingested_at");

		return {
			repoRoot,
			nodesByKind,
			edgesByKind,
			nodeTotal,
			edgeTotal,
			resolvedEdges,
			heuristicEdges,
			unresolvedCount,
			unresolvedByKind,
			resolutionRate,
			parseErrors,
			ingestMs,
			ingestedAt,
			callsResolved,
			callsHeuristic,
			callsUnresolved,
			callResolutionRate,
		};
	} finally {
		db.close();
	}
}

function groupCount(
	db: ReturnType<typeof openDB>,
	sql: string,
): Record<string, number> {
	const rows = db.prepare(sql).all() as { kind: string; n: number }[];
	return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

function scalar(db: ReturnType<typeof openDB>, sql: string): number {
	return (db.prepare(sql).get() as { n: number }).n;
}

function numMeta(db: ReturnType<typeof openDB>, key: string): number | null {
	const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
		{ value: string } | undefined;
	// return the number of the row value if row, otherwise null
	return row ? Number(row.value) : null;
}
