import { incrementalUpdate } from "../ingest/incremental.js";
import { findSymbol, type SymbolCandidate } from "../query/find-symbol.js";
import { getNeighborhood, type Direction } from "../query/neighborhood.js";
import { findPath, type FindPathResult } from "../query/path.js";
import { serializeNeighborhood, type ResultMeta } from "../query/serialize.js";
import { getSkeleton, type Skeleton } from "../query/skeleton.js";

export type Format = "json" | "text";

export interface ToolResult {
	text: string;
	meta: ResultMeta;
}

const EMPTY_META: ResultMeta = {
	resolution_summary: { resolved: 0, heuristic: 0 },
	unresolved_in_scope: [],
	truncated: false,
	truncation_reason: null,
};

/** Resolve a name to exactly one id, or hand back candidates (FR-MCP-2: never guess). */
function resolveSymbol(
	repoRoot: string,
	query: string,
): { ok: true; id: string } | { ok: false; candidates: SymbolCandidate[] } {
	const c = findSymbol(repoRoot, query);
	if (c.length === 0) return { ok: false, candidates: [] };
	const top = c[0]!;
	const tied = c.filter((x) => x.score === top.score);
	return tied.length === 1
		? { ok: true, id: top.id }
		: { ok: false, candidates: tied.slice(0, 10) };
}

function candidatesText(query: string, cands: SymbolCandidate[]): string {
	if (cands.length === 0) {
		return `No symbol matches "${query}". Call find_symbol with a partial name.`;
	}
	const lines = [
		`"${query}" is ambiguous — call again with a qualified name or file.ts:name:`,
	];
	for (const c of cands) {
		lines.push(`  ${c.qualifiedName}  (${c.kind})  ${c.file}:${c.line}`);
	}
	return lines.join("\n");
}

export function toolFindSymbol(
	repoRoot: string,
	args: { query: string; format?: Format },
): ToolResult {
	const cands = findSymbol(repoRoot, args.query);
	if ((args.format ?? "json") === "json") {
		return {
			text: JSON.stringify(
				{ query: args.query, candidates: cands },
				null,
				2,
			),
			meta: EMPTY_META,
		};
	}
	if (cands.length === 0) {
		return { text: `No symbol matches "${args.query}".`, meta: EMPTY_META };
	}
	const lines = [`${cands.length} match(es) for "${args.query}":`];
	for (const c of cands) {
		lines.push(`  ${c.qualifiedName}  (${c.kind})  ${c.file}:${c.line}`);
	}
	return { text: lines.join("\n"), meta: EMPTY_META };
}

export function toolNeighborhood(
	repoRoot: string,
	args: {
		symbol: string;
		depth?: number;
		direction?: Direction;
		format?: Format;
	},
): ToolResult {
	const r = resolveSymbol(repoRoot, args.symbol);
	if (!r.ok) {
		return {
			text: candidatesText(args.symbol, r.candidates),
			meta: EMPTY_META,
		};
	}
	const nh = getNeighborhood(
		repoRoot,
		r.id,
		args.depth ?? 2,
		args.direction ?? "both",
	);
	const s = serializeNeighborhood(nh, { format: args.format ?? "json" });
	return { text: s.content, meta: s.meta };
}

export function toolFindPath(
	repoRoot: string,
	args: {
		from_symbol: string;
		to_symbol: string;
		max_len?: number;
		format?: Format;
	},
): ToolResult {
	const from = resolveSymbol(repoRoot, args.from_symbol);
	if (!from.ok) {
		return {
			text: candidatesText(args.from_symbol, from.candidates),
			meta: EMPTY_META,
		};
	}
	const to = resolveSymbol(repoRoot, args.to_symbol);
	if (!to.ok) {
		return {
			text: candidatesText(args.to_symbol, to.candidates),
			meta: EMPTY_META,
		};
	}

	const res = findPath(repoRoot, from.id, to.id, args.max_len ?? 8);
	const meta: ResultMeta = {
		...EMPTY_META,
		resolution_summary: countStepResolutions(res),
	};
	return (args.format ?? "json") === "json"
		? { text: JSON.stringify(res, null, 2), meta }
		: { text: pathText(res), meta };
}

export function toolSkeleton(
	repoRoot: string,
	args: { format?: Format },
): ToolResult {
	const sk = getSkeleton(repoRoot);
	const meta: ResultMeta = {
		...EMPTY_META,
		resolution_summary: { resolved: sk.imports.length, heuristic: 0 },
	};
	return (args.format ?? "json") === "json"
		? { text: JSON.stringify(sk, null, 2), meta }
		: { text: skeletonText(sk), meta };
}

export function toolRefresh(repoRoot: string): ToolResult {
	const { report } = incrementalUpdate(repoRoot);
	return { text: JSON.stringify(report, null, 2), meta: EMPTY_META };
}

function countStepResolutions(res: FindPathResult): {
	resolved: number;
	heuristic: number;
} {
	let resolved = 0;
	let heuristic = 0;
	for (const s of res.steps) {
		if (s.resolution === "resolved") resolved++;
		else if (s.resolution === "heuristic") heuristic++;
	}
	return { resolved, heuristic };
}

function pathText(r: FindPathResult): string {
	if (!r.found) return r.message ?? "no path found";
	const out = [`path (${r.length} hop${r.length === 1 ? "" : "s"})`];
	r.nodes.forEach((n, i) => {
		out.push(`  ${n.kind} ${n.name}  ${n.location}`);
		const s = r.steps[i];
		if (s) out.push(`    | ${s.kind} [${s.resolution}]  ${s.at}`);
	});
	return out.join("\n");
}

function skeletonText(sk: Skeleton): string {
	const out: string[] = [];
	for (const m of sk.modules) {
		out.push(m.path);
		for (const e of m.exports) out.push(`  · ${e}`);
	}
	out.push("", `imports (${sk.imports.length})`);
	for (const e of sk.imports) out.push(`  ${e.fromPath} -> ${e.toPath}`);
	return out.join("\n");
}
