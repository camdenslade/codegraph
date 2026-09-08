import { openDB } from "../store/db.js";
import { LineResolver } from "./lines.js";

export interface ImpactSite {
	id: string;
	kind: string;
	name: string;
	qualifiedName: string;
	location: string; // file:line
	via: string; // CALLS | REFERENCES | HANDLES | override
	resolution: string; // resolved | heuristic
	hops: number;
}

export interface EditImpact {
	seed: {
		id: string;
		kind: string;
		name: string;
		qualifiedName: string;
		location: string;
		signature: string | null;
	};
	direct: ImpactSite[]; // 1 hop
	transitive: ImpactSite[]; // 2+ hops
	overrides: ImpactSite[]; // methods that override the seed
	routes: ImpactSite[]; // routes whose handler chain reaches the seed
	moduleImporters: number; // modules importing the seed's module (broad signal)
	meta: {
		resolved: number;
		heuristic: number;
		blastRadius: number;
		estReviewTokens: number;
		notes: string[];
		truncated: boolean;
	};
}

const HARD_CAP = 400; // sites before we truncate

/**
 * Everything that would need attention if `seedId` changed: reverse call/
 * reference slice, methods that override it, and routes whose handler chain
 * reaches it. Budgeted to a review payload, not a full graph dump.
 */
export function getEditImpact(
	repoRoot: string,
	seedId: string,
	maxHops = 3,
): EditImpact {
	const hops = Math.min(Math.max(Math.trunc(maxHops), 1), 5);
	const db = openDB(repoRoot);
	try {
		const seed = db
			.prepare(
				`SELECT id, kind, name, qualified_name, file, span_start, signature
				 FROM nodes WHERE id = ?`,
			)
			.get(seedId) as
			| {
					id: string;
					kind: string;
					name: string;
					qualified_name: string;
					file: string;
					span_start: number;
					signature: string | null;
			  }
			| undefined;
		if (!seed) throw new Error(`no node with id: ${seedId}`);

		const lines = new LineResolver(repoRoot);

		// Reverse slice along call-ish edges.
		const reached = db
			.prepare(
				`WITH RECURSIVE up(id, hops) AS (
				   SELECT @seed, 0
				   UNION
				   SELECT e.src, u.hops + 1
				   FROM up u
				   JOIN edges e ON e.dst = u.id
				   WHERE u.hops < @hops
				     AND e.kind IN ('CALLS', 'REFERENCES', 'HANDLES')
				 )
				 SELECT id, MIN(hops) AS hops FROM up WHERE id <> @seed GROUP BY id`,
			)
			.all({ seed: seedId, hops }) as { id: string; hops: number }[];

		const idJson = JSON.stringify(reached.map((r) => r.id));
		const hopById = new Map(reached.map((r) => [r.id, r.hops]));

		const nodeRows = db
			.prepare(
				`SELECT id, kind, name, qualified_name, file, span_start
				 FROM nodes WHERE id IN (SELECT value FROM json_each(?))`,
			)
			.all(idJson) as {
			id: string;
			kind: string;
			name: string;
			qualified_name: string;
			file: string;
			span_start: number;
		}[];

		// The edge that first reaches each sliced node (for `via` / `resolution`).
		const inEdges = db
			.prepare(
				`SELECT e.src, e.kind, e.resolution
				 FROM edges e
				 WHERE e.dst IN (SELECT value FROM json_each(@ids))
				   AND e.kind IN ('CALLS', 'REFERENCES', 'HANDLES')`,
			)
			.all({ ids: JSON.stringify([...hopById.keys(), seedId]) }) as {
			src: string;
			kind: string;
			resolution: string;
		}[];
		const edgeBySrc = new Map<
			string,
			{ kind: string; resolution: string }
		>();
		for (const e of inEdges) {
			if (!edgeBySrc.has(e.src)) {
				edgeBySrc.set(e.src, {
					kind: e.kind,
					resolution: e.resolution,
				});
			}
		}

		const site = (
			r: (typeof nodeRows)[number],
			viaOverride?: string,
		): ImpactSite => {
			const meta = edgeBySrc.get(r.id);
			return {
				id: r.id,
				kind: r.kind,
				name: r.name,
				qualifiedName: r.qualified_name,
				location: `${r.file}:${lines.lineAt(r.file, r.span_start)}`,
				via: viaOverride ?? meta?.kind ?? "CALLS",
				resolution: meta?.resolution ?? "resolved",
				hops: hopById.get(r.id) ?? 1,
			};
		};

		const sliced = nodeRows
			.map((r) => site(r))
			.sort((a, b) => a.hops - b.hops);
		const routes = sliced.filter((s) => s.kind === "route");
		const rest = sliced.filter((s) => s.kind !== "route");
		const direct = rest.filter((s) => s.hops === 1);
		const transitive = rest.filter((s) => s.hops > 1);

		// Overrides: subtypes of the seed's container that declare the same method.
		const overrides: ImpactSite[] = [];
		if (seed.kind === "method") {
			const container = seed.qualified_name.slice(
				seed.qualified_name.indexOf(":") + 1,
				seed.qualified_name.lastIndexOf("."),
			);
			const methodName = seed.name;
			const containerIds = db
				.prepare(
					`SELECT id FROM nodes
					 WHERE kind IN ('class', 'interface')
					   AND qualified_name = @qn`,
				)
				.all({ qn: `${seed.file}:${container}` }) as { id: string }[];
			for (const c of containerIds) {
				const subs = db
					.prepare(
						`SELECT n.file, n.name FROM edges e
						 JOIN nodes n ON n.id = e.src
						 WHERE e.dst = @cid AND e.kind IN ('EXTENDS', 'IMPLEMENTS')`,
					)
					.all({ cid: c.id }) as { file: string; name: string }[];
				for (const s of subs) {
					const overrideRow = db
						.prepare(
							`SELECT id, kind, name, qualified_name, file, span_start
							 FROM nodes WHERE qualified_name = @qn AND kind = 'method'`,
						)
						.get({ qn: `${s.file}:${s.name}.${methodName}` }) as
						(typeof nodeRows)[number] | undefined;
					if (overrideRow) {
						overrides.push(site(overrideRow, "override"));
					}
				}
			}
		}

		const moduleImporters = (
			db
				.prepare(
					`SELECT COUNT(*) AS n FROM edges
					 WHERE kind = 'IMPORTS' AND dst = @mod`,
				)
				.get({ mod: `module:${seed.file}` }) as { n: number }
		).n;

		const all = [...direct, ...transitive, ...overrides, ...routes];
		let resolved = 0;
		let heuristic = 0;
		for (const s of all) {
			if (s.resolution === "resolved") resolved++;
			else if (s.resolution === "heuristic") heuristic++;
		}

		const notes: string[] = [];
		if (seed.file.endsWith(".java")) {
			notes.push(
				"Java callers are found syntactically; chained-call and stream-pipeline call sites are missing.",
			);
		}
		if (heuristic > 0) {
			notes.push(
				`${heuristic} of the sites were reached by a heuristic edge - verify before relying on them.`,
			);
		}
		const truncated = all.length > HARD_CAP;

		return {
			seed: {
				id: seed.id,
				kind: seed.kind,
				name: seed.name,
				qualifiedName: seed.qualified_name,
				location: `${seed.file}:${lines.lineAt(seed.file, seed.span_start)}`,
				signature: seed.signature,
			},
			direct: cap(direct, truncated),
			transitive: cap(transitive, truncated),
			overrides,
			routes,
			moduleImporters,
			meta: {
				resolved,
				heuristic,
				blastRadius: all.length,
				estReviewTokens: direct.length * 30 + transitive.length * 12,
				notes,
				truncated,
			},
		};
	} finally {
		db.close();
	}
}

function cap(sites: ImpactSite[], truncated: boolean): ImpactSite[] {
	return truncated ? sites.slice(0, HARD_CAP) : sites;
}

export function renderImpact(i: EditImpact): string {
	const out: string[] = [];
	out.push(`EDIT IMPACT  ${i.seed.kind} ${i.seed.name}  ${i.seed.location}`);
	if (i.seed.signature) out.push(`  ${i.seed.signature}`);
	out.push(
		`  blast radius: ${i.meta.blastRadius} sites  (~${i.meta.estReviewTokens} tokens to review the direct ones)`,
	);

	const list = (label: string, sites: ImpactSite[]) => {
		if (sites.length === 0) return;
		out.push("", `${label} (${sites.length})`);
		for (const s of sites) {
			out.push(
				`  ${s.via}  ${s.name}  ${s.location}  [${s.resolution}]` +
					(s.hops > 1 ? `  ${s.hops} hops` : ""),
			);
		}
	};
	list("DIRECT callers / references", i.direct);
	list("TRANSITIVE", i.transitive);
	list("OVERRIDES", i.overrides);
	list("ROUTES reaching this", i.routes);

	out.push("", "META");
	if (i.moduleImporters > 0) {
		out.push(
			`  ${i.moduleImporters} modules import this symbol's module (broad; not enumerated)`,
		);
	}
	out.push(
		`  edges: ${i.meta.resolved} resolved, ${i.meta.heuristic} heuristic`,
	);
	for (const n of i.meta.notes) out.push(`  ! ${n}`);
	out.push(
		`  truncated: ${i.meta.truncated ? `yes (cap ${HARD_CAP})` : "no"}`,
	);
	return out.join("\n");
}
