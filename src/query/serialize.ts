import type { Neighborhood, NeighborhoodEdge, NeighborhoodNode } from "./neighborhood.js";

export interface ResultMeta {
  resolution_summary: { resolved: number; heuristic: number };
  unresolved_in_scope: { kind: string; text: string; file: string; line: number }[];
  truncated: boolean;
  truncation_reason: string | null;
}

export interface SerializedResult {
  content: string;
  meta: ResultMeta;
}

export interface SerializeOptions {
  format?: "json" | "text";
  targetTokens?: number; // soft goal — FR-SLICE-3
  maxTokens?: number; // hard ceiling
}

interface Level {
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
  reasons: string[];
  omitted: number;
}

const estTokens = (s: string): number => Math.ceil(s.length / 4);

export function serializeNeighborhood(
  nh: Neighborhood,
  opts: SerializeOptions = {},
): SerializedResult {
  const format = opts.format ?? "json";
  const target = opts.targetTokens ?? 1500;
  const max = opts.maxTokens ?? 4000;

  let chosen = buildLevels(nh)[0]!;
  let meta = buildMeta(chosen, nh);
  let content = render(nh.seed, chosen, meta, format);

  for (const level of buildLevels(nh)) {
    chosen = level;
    meta = buildMeta(level, nh);
    content = render(nh.seed, level, meta, format);
    if (estTokens(content) <= target) break;
  }

  if (estTokens(content) > max) {
    const t = truncateSiblings(nh.seed, chosen, nh, format, max);
    chosen = t.level;
    meta = buildMeta(t.level, nh);
    content = t.content;
  }

  return { content, meta };
}

/** Progressively smaller views: full -> no REFERENCES -> shrinking depth. */
function buildLevels(nh: Neighborhood): Level[] {
  const maxDepth = Math.max(0, ...nh.nodes.map((n) => n.depth));
  const levels: Level[] = [
    { nodes: nh.nodes, edges: nh.edges, reasons: [], omitted: 0 },
  ];

  const noRef = nh.edges.filter((e) => e.kind !== "REFERENCES");
  levels.push({
    nodes: connectedToSeed(nh.seed.id, nh.nodes, noRef),
    edges: noRef,
    reasons: ["dropped REFERENCES edges"],
    omitted: 0,
  });

  for (let d = maxDepth - 1; d >= 1; d--) {
    const nodes = nh.nodes.filter((n) => n.depth <= d);
    const ids = new Set(nodes.map((n) => n.id));
    levels.push({
      nodes,
      edges: noRef.filter((e) => ids.has(e.src) && ids.has(e.dst)),
      reasons: ["dropped REFERENCES edges", `reduced depth to ${d}`],
      omitted: 0,
    });
  }
  return levels;
}

function truncateSiblings(
  seed: NeighborhoodNode,
  level: Level,
  nh: Neighborhood,
  format: "json" | "text",
  max: number,
): { level: Level; content: string } {
  const neighbors = level.nodes
    .filter((n) => n.id !== seed.id)
    .sort((a, b) => a.depth - b.depth);

  let keep = neighbors.length;
  let result: Level = level;
  let content = render(seed, level, buildMeta(level, nh), format);

  while (keep > 0) {
    const kept = neighbors.slice(0, keep);
    const ids = new Set([seed.id, ...kept.map((n) => n.id)]);
    result = {
      nodes: [seed, ...kept],
      edges: level.edges.filter((e) => ids.has(e.src) && ids.has(e.dst)),
      reasons: [...level.reasons, `omitted ${neighbors.length - keep} distant nodes`],
      omitted: neighbors.length - keep,
    };
    content = render(seed, result, buildMeta(result, nh), format);
    if (estTokens(content) <= max) break;
    keep = Math.floor(keep * 0.75) - 1;
  }
  return { level: result, content };
}

function buildMeta(level: Level, nh: Neighborhood): ResultMeta {
  let resolved = 0;
  let heuristic = 0;
  for (const e of level.edges) {
    if (e.resolution === "resolved") resolved++;
    else if (e.resolution === "heuristic") heuristic++;
  }
  const ids = new Set(level.nodes.map((n) => n.id));
  return {
    resolution_summary: { resolved, heuristic },
    unresolved_in_scope: nh.unresolvedInScope
      .filter((u) => ids.has(u.nodeId))
      .map((u) => ({ kind: u.kind, text: u.text, file: u.file, line: u.line })),
    truncated: level.reasons.length > 0 || level.omitted > 0,
    truncation_reason: level.reasons.length ? level.reasons.join("; ") : null,
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

function renderJson(seed: NeighborhoodNode, level: Level, meta: ResultMeta): string {
  const node = (n: NeighborhoodNode) => ({
    id: n.id,
    kind: n.kind,
    name: n.name,
    qualified_name: n.qualifiedName,
    location: `${n.file}:${n.line}`,
    signature: n.signature,
    doc: n.doc,
    depth: n.depth,
  });
  const edge = (e: NeighborhoodEdge) => ({
    from: e.src,
    to: e.dst,
    kind: e.kind,
    resolution: e.resolution,
    at: `${e.file}:${e.line}`,
  });
  return JSON.stringify(
    {
      seed: node(seed),
      nodes: level.nodes.filter((n) => n.id !== seed.id).map(node),
      edges: level.edges.map(edge),
      omitted: level.omitted,
      meta,
    },
    null,
    2,
  );
}

function renderText(seed: NeighborhoodNode, level: Level, meta: ResultMeta): string {
  const byId = new Map(level.nodes.map((n) => [n.id, n]));
  const nm = (id: string) => byId.get(id)?.name ?? id;
  const lines: string[] = [];

  lines.push(`SEED  ${seed.kind} ${seed.name}  ${seed.file}:${seed.line}`);
  if (seed.signature) lines.push(`  ${seed.signature}`);
  if (seed.doc) lines.push(`  ${seed.doc.split("\n")[0]!.trim()}`);

  lines.push("", `EDGES (${level.edges.length})`);
  for (const e of level.edges) {
    lines.push(
      `  ${nm(e.src)} --${e.kind}--> ${nm(e.dst)}  [${e.resolution}]  ${e.file}:${e.line}`,
    );
  }

  const others = level.nodes.filter((n) => n.id !== seed.id);
  lines.push("", `NODES (${others.length})`);
  for (const n of others) {
    lines.push(`  ${n.kind} ${n.name}  ${n.file}:${n.line}  depth ${n.depth}`);
  }
  if (level.omitted > 0) lines.push(`  ...${level.omitted} more omitted`);

  lines.push("", "META");
  lines.push(
    `  edges: ${meta.resolution_summary.resolved} resolved, ${meta.resolution_summary.heuristic} heuristic`,
  );
  lines.push(`  unresolved in scope (${meta.unresolved_in_scope.length})`);
  for (const u of meta.unresolved_in_scope) {
    lines.push(`    ${u.kind} "${u.text}"  ${u.file}:${u.line}`);
  }
  lines.push(`  truncated: ${meta.truncation_reason ?? "no"}`);

  return lines.join("\n");
}
