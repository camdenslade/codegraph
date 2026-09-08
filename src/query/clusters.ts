import type { DB } from "../store/db.js";

export interface ModuleCluster {
	label: string; // common path prefix, or the most-connected module
	modules: string[]; // module paths, sorted
	internalEdges: number; // IMPORTS wholly inside the cluster
	externalEdges: number; // IMPORTS crossing the boundary
}

/**
 * Group modules into cohesive areas by their IMPORTS coupling, using
 * deterministic label propagation (process nodes in sorted order, take the most
 * common neighbor label, break ties by smallest label). Finds groups that can
 * cross directory boundaries or split a big directory by real coupling - not
 * just `dirname`.
 */
export function computeModuleClusters(db: DB): ModuleCluster[] {
	const modules = (
		db
			.prepare(
				`SELECT qualified_name AS p FROM nodes WHERE kind = 'module'`,
			)
			.all() as { p: string }[]
	)
		.map((r) => r.p)
		.sort();
	if (modules.length === 0) return [];

	const idx = new Map(modules.map((m, i) => [m, i]));
	const adj: number[][] = modules.map(() => []);
	const edges = db
		.prepare(
			`SELECT s.qualified_name AS a, d.qualified_name AS b
			 FROM edges e
			 JOIN nodes s ON s.id = e.src
			 JOIN nodes d ON d.id = e.dst
			 WHERE e.kind = 'IMPORTS'`,
		)
		.all() as { a: string; b: string }[];
	for (const { a, b } of edges) {
		const i = idx.get(a);
		const j = idx.get(b);
		if (i === undefined || j === undefined || i === j) continue;
		adj[i]!.push(j);
		adj[j]!.push(i);
	}

	// Label propagation.
	const label = modules.map((_, i) => i);
	for (let pass = 0; pass < 20; pass++) {
		let moved = false;
		for (let i = 0; i < modules.length; i++) {
			const counts = new Map<number, number>();
			for (const n of adj[i]!) {
				counts.set(label[n]!, (counts.get(label[n]!) ?? 0) + 1);
			}
			if (counts.size === 0) continue;
			let best = label[i]!;
			let bestCount = -1;
			for (const [l, c] of counts) {
				if (c > bestCount || (c === bestCount && l < best)) {
					best = l;
					bestCount = c;
				}
			}
			if (best !== label[i]) {
				label[i] = best;
				moved = true;
			}
		}
		if (!moved) break;
	}

	// Assemble clusters.
	const byLabel = new Map<number, number[]>();
	for (let i = 0; i < modules.length; i++) {
		(
			byLabel.get(label[i]!) ?? byLabel.set(label[i]!, []).get(label[i]!)!
		).push(i);
	}

	const clusters: ModuleCluster[] = [];
	const isolated: string[] = [];
	for (const members of byLabel.values()) {
		// A lone module with no in-repo imports is not an "area" - collect them.
		if (members.length === 1 && adj[members[0]!]!.length === 0) {
			isolated.push(modules[members[0]!]!);
			continue;
		}
		const set = new Set(members);
		const paths = members.map((i) => modules[i]!).sort();
		let internal = 0;
		let external = 0;
		for (const i of members) {
			for (const n of adj[i]!) {
				if (set.has(n)) internal++;
				else external++;
			}
		}
		clusters.push({
			label: clusterLabel(paths),
			modules: paths,
			internalEdges: internal / 2,
			externalEdges: external,
		});
	}
	if (isolated.length > 0) {
		clusters.push({
			label: `isolated modules (${isolated.length}, no in-repo imports)`,
			modules: isolated.sort(),
			internalEdges: 0,
			externalEdges: 0,
		});
	}
	return clusters.sort((a, b) => b.modules.length - a.modules.length);
}

function clusterLabel(paths: string[]): string {
	if (paths.length === 1) return paths[0]!;

	const segs = paths[0]!.split("/");
	let prefix = "";
	for (let d = 0; d < segs.length - 1; d++) {
		const cand = segs.slice(0, d + 1).join("/") + "/";
		if (paths.every((p) => p.startsWith(cand))) prefix = cand;
		else break;
	}

	// The distinct sub-areas under the common prefix - more telling than the
	// prefix alone when it is something generic like "src/".
	const subs = new Set<string>();
	for (const p of paths) {
		const rest = p.slice(prefix.length).split("/");
		if (rest.length > 1) subs.add(rest[0]!);
	}
	if (subs.size === 0) return prefix || `${paths.length} modules`;
	if (subs.size <= 4) {
		return [...subs]
			.sort()
			.map((s) => `${prefix}${s}/`)
			.join(", ");
	}
	return `${prefix}(${subs.size} subtrees)`;
}
