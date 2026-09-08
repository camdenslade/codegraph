import type {
	Neighborhood,
	NeighborhoodEdge,
	NeighborhoodNode,
} from "./neighborhood.js";

export interface ResultMeta {
	resolution_summary: { resolved: number; heuristic: number };
	unresolved_in_scope: {
		kind: string;
		text: string;
		file: string;
		line: number;
	}[];
	truncated: boolean;
	truncation_reason: string | null;
	/** Total neighbor nodes reachable; may exceed what the payload shows. */
	total_neighbors: number;
	shown_neighbors: number;
	/** Caveats the caller must weigh, e.g. a language whose call graph is partial. */
	notes: string[];
}

export interface SerializedResult {
	content: string;
	meta: ResultMeta;
}

export interface SerializeOptions {
	format?: "json" | "text";
	targetTokens?: number; // soft goal - FR-SLICE-3
	maxTokens?: number; // hard ceiling
	/** Emit every reachable node/edge, no budget, no truncation. */
	full?: boolean;
}

interface Level {
	nodes: NeighborhoodNode[];
	edges: NeighborhoodEdge[];
	reasons: string[];
	omitted: number;
	/** Drop per-node signatures/docs to fit more nodes. */
	compact: boolean;
}

const estTokens = (s: string): number => Math.ceil(s.length / 4);

export function serializeNeighborhood(
	nh: Neighborhood,
	opts: SerializeOptions = {},
): SerializedResult {
	const format = opts.format ?? "json";
	const target = opts.targetTokens ?? 1500;
	const max = opts.full ? Infinity : (opts.maxTokens ?? 4000);
	const totalNeighbors = nh.nodes.filter((n) => n.id !== nh.seed.id).length;

	const levels = opts.full
		? [
				{
					nodes: nh.nodes,
					edges: nh.edges,
					reasons: [],
					omitted: 0,
					compact: false,
				},
			]
		: buildLevels(nh);

	let chosen: Level = levels[0]!;
	let content = render(
		nh.seed,
		chosen,
		buildMeta(chosen, nh, totalNeighbors),
		format,
	);

	// Walk down the degradation ladder until we're under the soft target.
	for (let i = 1; i < levels.length && estTokens(content) > target; i++) {
		chosen = levels[i]!;
		content = render(
			nh.seed,
			chosen,
			buildMeta(chosen, nh, totalNeighbors),
			format,
		);
	}

	// Last resort: drop the most distant neighbors to fit the hard ceiling.
	if (estTokens(content) > max) {
		const t = truncateSiblings(
			nh.seed,
			chosen,
			nh,
			format,
			max,
			totalNeighbors,
		);
		chosen = t.level;
		content = t.content;
	}

	return { content, meta: buildMeta(chosen, nh, totalNeighbors) };
}

/** full -> no REFERENCES -> shrinking depth -> compact (no signatures). */
function buildLevels(nh: Neighborhood): Level[] {
	const maxDepth = Math.max(0, ...nh.nodes.map((n) => n.depth));
	const levels: Level[] = [
		{
			nodes: nh.nodes,
			edges: nh.edges,
			reasons: [],
			omitted: 0,
			compact: false,
		},
	];

	const noRef = nh.edges.filter((e) => e.kind !== "REFERENCES");
	levels.push({
		nodes: connectedToSeed(nh.seed.id, nh.nodes, noRef),
		edges: noRef,
		reasons: ["dropped REFERENCES edges"],
		omitted: 0,
		compact: false,
	});

	for (let d = maxDepth - 1; d >= 1; d--) {
		const nodes = nh.nodes.filter((n) => n.depth <= d);
		const ids = new Set(nodes.map((n) => n.id));
		levels.push({
			nodes,
			edges: noRef.filter((e) => ids.has(e.src) && ids.has(e.dst)),
			reasons: ["dropped REFERENCES edges", `reduced depth to ${d}`],
			omitted: 0,
			compact: false,
		});
	}

	// Compact: keep every depth-1 node but drop signatures. This is what lets a
	// hot node's full caller list fit instead of getting sibling-truncated.
	const d1 = nh.nodes.filter((n) => n.depth <= 1);
	const d1ids = new Set(d1.map((n) => n.id));
	levels.push({
		nodes: d1,
		edges: noRef.filter((e) => d1ids.has(e.src) && d1ids.has(e.dst)),
		reasons: ["compact: signatures dropped", "depth 1 only"],
		omitted: 0,
		compact: true,
	});

	return levels;
}

function truncateSiblings(
	seed: NeighborhoodNode,
	level: Level,
	nh: Neighborhood,
	format: "json" | "text",
	max: number,
	totalNeighbors: number,
): { level: Level; content: string } {
	const neighbors = level.nodes
		.filter((n) => n.id !== seed.id)
		.sort((a, b) => a.depth - b.depth);

	let keep = neighbors.length;
	let result: Level = level;
	let content = render(
		seed,
		level,
		buildMeta(level, nh, totalNeighbors),
		format,
	);

	while (keep > 0) {
		const kept = neighbors.slice(0, keep);
		const ids = new Set([seed.id, ...kept.map((n) => n.id)]);
		result = {
			nodes: [seed, ...kept],
			edges: level.edges.filter((e) => ids.has(e.src) && ids.has(e.dst)),
			reasons: [
				...level.reasons,
				`omitted ${totalNeighbors - keep} of ${totalNeighbors} neighbors to fit the token budget - re-run with full=true for the complete list`,
			],
			omitted: totalNeighbors - keep,
			compact: true,
		};
		content = render(
			seed,
			result,
			buildMeta(result, nh, totalNeighbors),
			format,
		);
		if (estTokens(content) <= max) break;
		keep = Math.floor(keep * 0.75) - 1;
	}
	return { level: result, content };
}

function buildMeta(
	level: Level,
	nh: Neighborhood,
	totalNeighbors: number,
): ResultMeta {
	let resolved = 0;
	let heuristic = 0;
	for (const e of level.edges) {
		if (e.resolution === "resolved") resolved++;
		else if (e.resolution === "heuristic") heuristic++;
	}
	const notes: string[] = [];
	const seedIsJava = nh.seed.file.endsWith(".java");
	const seedHasCalls = level.edges.some(
		(e) =>
			e.kind === "CALLS" &&
			(e.src === nh.seed.id || e.dst === nh.seed.id),
	);
	if (seedIsJava && !seedHasCalls) {
		notes.push(
			"Java call edges are not modeled in v1: no CALLS here does NOT mean the method is unused or calls nothing - read the file to confirm.",
		);
	}

	// Only the seed's own unresolved refs matter for "should I still read the
	// file". A hot node's neighbors drag in hundreds of JS-builtin / npm noise
	// entries that just burn budget.
	const seedUnresolved = nh.unresolvedInScope
		.filter((u) => u.nodeId === nh.seed.id)
		.map((u) => ({
			kind: u.kind,
			text: u.text,
			file: u.file,
			line: u.line,
		}));

	return {
		resolution_summary: { resolved, heuristic },
		unresolved_in_scope: seedUnresolved,
		// "truncated" means nodes were actually dropped. Compacting detail while
		// keeping every node is reported in truncation_reason, not as truncation.
		truncated: level.omitted > 0,
		truncation_reason: level.reasons.length
			? level.reasons.join("; ")
			: null,
		total_neighbors: totalNeighbors,
		shown_neighbors: level.nodes.filter((n) => n.id !== nh.seed.id).length,
		notes,
	};
}

function connectedToSeed(
	seedId: string,
	nodes: NeighborhoodNode[],
	edges: NeighborhoodEdge[],
): NeighborhoodNode[] {
	const adj = new Map<string, string[]>();
	for (const e of edges) {
		(adj.get(e.src) ?? adj.set(e.src, []).get(e.src)!).push(e.dst);
		(adj.get(e.dst) ?? adj.set(e.dst, []).get(e.dst)!).push(e.src);
	}
	const seen = new Set([seedId]);
	const queue = [seedId];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const nxt of adj.get(cur) ?? []) {
			if (!seen.has(nxt)) {
				seen.add(nxt);
				queue.push(nxt);
			}
		}
	}
	return nodes.filter((n) => seen.has(n.id));
}

function render(
	seed: NeighborhoodNode,
	level: Level,
	meta: ResultMeta,
	format: "json" | "text",
): string {
	return format === "json"
		? renderJson(seed, level, meta)
		: renderText(seed, level, meta);
}

function renderJson(
	seed: NeighborhoodNode,
	level: Level,
	meta: ResultMeta,
): string {
	const node = (n: NeighborhoodNode) =>
		level.compact
			? {
					id: n.id,
					kind: n.kind,
					name: n.name,
					location: `${n.file}:${n.line}`,
					depth: n.depth,
				}
			: {
					id: n.id,
					kind: n.kind,
					name: n.name,
					qualified_name: n.qualifiedName,
					location: `${n.file}:${n.line}`,
					signature: n.signature,
					doc: n.doc,
					depth: n.depth,
				};
	const edge = (e: NeighborhoodEdge) => ({
		from: e.src,
		to: e.dst,
		kind: e.kind,
		resolution: e.resolution,
		at: `${e.file}:${e.line}`,
	});
	return JSON.stringify(
		{
			seed: {
				id: seed.id,
				kind: seed.kind,
				name: seed.name,
				qualified_name: seed.qualifiedName,
				location: `${seed.file}:${seed.line}`,
				signature: seed.signature,
			},
			nodes: level.nodes.filter((n) => n.id !== seed.id).map(node),
			edges: level.edges.map(edge),
			omitted: level.omitted,
			meta,
		},
		null,
		2,
	);
}

function renderText(
	seed: NeighborhoodNode,
	level: Level,
	meta: ResultMeta,
): string {
	const byId = new Map(level.nodes.map((n) => [n.id, n]));
	const nm = (id: string) => byId.get(id)?.name ?? id;
	const loc = (id: string) => {
		const n = byId.get(id);
		return n ? `${n.file}:${n.line}` : "";
	};
	const lines: string[] = [];

	lines.push(`SEED  ${seed.kind} ${seed.name}  ${seed.file}:${seed.line}`);
	if (seed.signature) lines.push(`  ${seed.signature}`);
	if (seed.doc && !level.compact) {
		lines.push(`  ${seed.doc.split("\n")[0]!.trim()}`);
	}

	const upstream = level.edges.filter((e) => e.dst === seed.id);
	const downstream = level.edges.filter((e) => e.src === seed.id);
	const other = level.edges.filter(
		(e) => e.src !== seed.id && e.dst !== seed.id,
	);

	if (upstream.length) {
		lines.push("", `UPSTREAM (${upstream.length})  callers / importers`);
		for (const e of upstream) {
			lines.push(
				`  ${e.kind}  ${nm(e.src)}  ${loc(e.src)}  [${e.resolution}]`,
			);
		}
	}
	if (downstream.length) {
		lines.push("", `DOWNSTREAM (${downstream.length})  callees / imports`);
		for (const e of downstream) {
			lines.push(
				`  ${e.kind}  ${nm(e.dst)}  ${loc(e.dst)}  [${e.resolution}]`,
			);
		}
	}
	if (other.length) {
		lines.push("", `OTHER (${other.length})`);
		for (const e of other) {
			lines.push(
				`  ${nm(e.src)} --${e.kind}--> ${nm(e.dst)}  [${e.resolution}]  ${e.file}:${e.line}`,
			);
		}
	}

	if (level.omitted > 0) {
		lines.push(
			"",
			`... ${level.omitted} of ${meta.total_neighbors} neighbors omitted (${meta.shown_neighbors} shown). Re-run with full=true / --full for all.`,
		);
	}

	lines.push("", "META");
	for (const n of meta.notes) lines.push(`  ! ${n}`);
	lines.push(
		`  edges: ${meta.resolution_summary.resolved} resolved, ${meta.resolution_summary.heuristic} heuristic`,
	);
	lines.push(
		`  neighbors: ${meta.shown_neighbors} shown of ${meta.total_neighbors}`,
	);
	lines.push(`  unresolved in scope (${meta.unresolved_in_scope.length})`);
	for (const u of meta.unresolved_in_scope) {
		lines.push(`    ${u.kind} "${u.text}"  ${u.file}:${u.line}`);
	}
	lines.push(`  truncated: ${meta.truncation_reason ?? "no"}`);

	return lines.join("\n");
}
