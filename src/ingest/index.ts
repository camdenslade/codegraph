import { readFileSync, statSync } from "node:fs";
import { canonicalRoot } from "../store/db.js";
import { performance } from "node:perf_hooks";
import { ANALYZERS } from "../lang/registry.js";
import type { EndpointCall, ParsedUnit } from "../lang/types.js";
import { openDB } from "../store/db.js";
import { crossLink } from "./crosslink.js";
import {
	hashText,
	persistEdges,
	persistRouteNodes,
	persistUnits,
	persistUnresolved,
	toRelPath,
	type UnitInput,
} from "../store/persist.js";
import { buildNodeIndex } from "./node-index.js";

export interface IngestOptions {
	fresh?: boolean;
}

export interface IngestReport {
	repoRoot: string;
	filesDiscovered: number;
	filesParsed: number;
	filesErrored: number;
	nodeCount: number;
	edgeCount: number;
	unresolvedCount: number;
	elapsedMs: number;
}

interface AnalyzerRun {
	discovered: ReturnType<(typeof ANALYZERS)[number]["discoverFiles"]>;
	units: ParsedUnit[];
	errors: { file: string; message: string }[];
	analyzer: (typeof ANALYZERS)[number];
}

export function ingest(
	repoRoot: string,
	opts: IngestOptions = {},
): IngestReport {
	const started = performance.now();
	const root = canonicalRoot(repoRoot);
	const db = openDB(root, { fresh: opts.fresh ?? false });

	// Phase 1: discover + parse + persist nodes, for every language.
	const runs: AnalyzerRun[] = [];
	for (const analyzer of ANALYZERS) {
		const discovered = analyzer.discoverFiles(repoRoot);
		const units: ParsedUnit[] = [];
		const errors: { file: string; message: string }[] = [];
		const inputs: UnitInput[] = [];

		for (const abs of discovered.files) {
			const relPath = toRelPath(discovered.repoRoot, abs);
			try {
				const source = readFileSync(abs, "utf8");
				const mtimeMs = statSync(abs).mtimeMs;
				const unit = analyzer.parseFile(relPath, abs, source);
				units.push(unit);
				inputs.push({
					relPath,
					hash: hashText(source),
					mtimeMs,
					symbols: unit.symbols,
				});
			} catch (err) {
				errors.push({ file: relPath, message: (err as Error).message });
			}
		}
		persistUnits(db, inputs);
		runs.push({ analyzer, discovered, units, errors });
	}

	// Phase 2: resolve edges, with every node from every language visible.
	const index = buildNodeIndex(db);
	const endpointCalls: EndpointCall[] = [];
	for (const { analyzer, discovered, units } of runs) {
		const out = analyzer.resolveEdges({
			repoRoot: discovered.repoRoot,
			discovered,
			units,
			allRelPaths: units.map((u) => u.relPath),
			index,
		});
		persistRouteNodes(db, out.routeNodes);
		persistEdges(db, out.edges);
		persistUnresolved(db, out.unresolved);
		if (out.endpointCalls) endpointCalls.push(...out.endpointCalls);
	}

	// Phase 3: cross-language - link client HTTP calls to route nodes (needs
	// every route persisted first).
	persistEdges(db, crossLink(db, endpointCalls));

	// Parse errors.
	const errors = runs.flatMap((r) => r.errors);
	db.transaction(() => {
		const clear = db.prepare(`DELETE FROM parse_errors WHERE file = ?`);
		const ins = db.prepare(
			`INSERT INTO parse_errors(file, message, at) VALUES(?, ?, ?)`,
		);
		const now = Date.now();
		for (const e of errors) {
			clear.run(e.file);
			ins.run(e.file, e.message, now);
		}
	})();

	// Metadata.
	const elapsedMs = Math.round(performance.now() - started);
	writeInputSetHash(db);
	const setMeta = db.prepare(
		`INSERT INTO meta(key, value) VALUES(?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	setMeta.run("repo_root", root);
	setMeta.run("ingested_at", String(Date.now()));
	setMeta.run("ingest_ms", String(elapsedMs));

	const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
	const filesDiscovered = runs.reduce(
		(n, r) => n + r.discovered.files.length,
		0,
	);
	const report: IngestReport = {
		repoRoot: root,
		filesDiscovered,
		filesParsed: runs.reduce((n, r) => n + r.units.length, 0),
		filesErrored: errors.length,
		nodeCount: count(`SELECT COUNT(*) AS n FROM nodes`),
		edgeCount: count(`SELECT COUNT(*) AS n FROM edges`),
		unresolvedCount: count(`SELECT COUNT(*) AS n FROM unresolved`),
		elapsedMs,
	};

	db.close();
	return report;
}

export function writeInputSetHash(db: import("../store/db.js").DB): void {
	const rows = db.prepare(`SELECT path, hash FROM files`).all() as {
		path: string;
		hash: string;
	}[];
	const h = hashText(
		rows
			.map((r) => `${r.path}:${r.hash}`)
			.sort()
			.join("\n"),
	);
	db.prepare(
		`INSERT INTO meta(key, value) VALUES('input_set_hash', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(h);
}
