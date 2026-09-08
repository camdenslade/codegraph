import { readFileSync, statSync } from "node:fs";
import { canonicalRoot } from "../store/db.js";
import { performance } from "node:perf_hooks";
import { ANALYZERS } from "../lang/registry.js";
import type { LanguageAnalyzer, ParsedUnit } from "../lang/types.js";
import { openDB, type DB } from "../store/db.js";
import {
	hashText,
	persistEdges,
	persistRouteNodes,
	persistUnits,
	persistUnresolved,
	toRelPath,
	type EdgeRow,
	type UnitInput,
} from "../store/persist.js";
import { buildNodeIndex } from "./node-index.js";
import { writeInputSetHash } from "./index.js";

export interface RefreshReport {
	repoRoot: string;
	added: string[];
	changed: string[];
	removed: string[];
	unchanged: number;
	nodeCount: number;
	edgeCount: number;
	unresolvedCount: number;
	elapsedMs: number;
	noop: boolean;
}

export interface RefreshOptions {
	/** Analyzer id -> carried state (warm ts.Program) from a previous run. */
	carry?: Map<string, unknown>;
}

export interface RefreshOutcome {
	report: RefreshReport;
	/** Analyzer id -> new carried state. Watch mode keeps this. */
	carry: Map<string, unknown>;
}

interface Discovered {
	analyzer: LanguageAnalyzer;
	repoRoot: string;
	absByRel: Map<string, string>;
}

/**
 * Reparse only files whose content hash changed (or are new), drop files that
 * disappeared. Inbound edges from files we do NOT reparse are snapshotted and
 * restored (FR-INC-2). Full re-resolution of importers is deferred to `ingest`.
 */
export function incrementalUpdate(
	repoRoot: string,
	opts: RefreshOptions = {},
): RefreshOutcome {
	const started = performance.now();
	const root = canonicalRoot(repoRoot);
	const db = openDB(root);
	const carryOut = new Map<string, unknown>();

	try {
		// 1. Discover across all languages, diff against stored hashes.
		const stored = new Map(
			(
				db.prepare(`SELECT path, hash FROM files`).all() as {
					path: string;
					hash: string;
				}[]
			).map((r) => [r.path, r.hash] as const),
		);

		const discovered: Discovered[] = [];
		const relToAnalyzer = new Map<string, LanguageAnalyzer>();
		const currentRel = new Set<string>();
		const added: string[] = [];
		const changed: string[] = [];
		let unchanged = 0;

		for (const analyzer of ANALYZERS) {
			const d = analyzer.discoverFiles(repoRoot);
			const absByRel = new Map<string, string>();
			for (const abs of d.files) {
				const rel = toRelPath(d.repoRoot, abs);
				absByRel.set(rel, abs);
				currentRel.add(rel);
				relToAnalyzer.set(rel, analyzer);
				let hash: string;
				try {
					hash = hashText(readFileSync(abs, "utf8"));
				} catch {
					continue;
				}
				const prev = stored.get(rel);
				if (prev === undefined) added.push(rel);
				else if (prev !== hash) changed.push(rel);
				else unchanged++;
			}
			discovered.push({ analyzer, repoRoot: d.repoRoot, absByRel });
		}
		const removed = [...stored.keys()].filter((p) => !currentRel.has(p));
		const toReparse = [...added, ...changed];

		if (toReparse.length === 0 && removed.length === 0) {
			return {
				report: countsReport(db, root, {
					added,
					changed,
					removed,
					unchanged,
					elapsedMs: Math.round(performance.now() - started),
					noop: true,
				}),
				carry: carryOut,
			};
		}

		// 2. Snapshot inbound edges from files we will NOT reparse (FR-INC-2).
		const affected = JSON.stringify([...toReparse, ...removed]);
		const inbound = db
			.prepare(
				`SELECT e.src, e.dst, e.kind, e.resolution, e.file, e.line
				 FROM edges e
				 JOIN nodes d ON d.id = e.dst
				 JOIN nodes s ON s.id = e.src
				 WHERE d.file IN (SELECT value FROM json_each(@aff))
				   AND s.file NOT IN (SELECT value FROM json_each(@aff))`,
			)
			.all({ aff: affected }) as EdgeRow[];

		// 3. Drop vanished files (cascade clears nodes/edges/unresolved).
		const dropFile = db.prepare(`DELETE FROM files WHERE path = ?`);
		db.transaction((paths: string[]) => {
			for (const p of paths) dropFile.run(p);
		})(removed);

		// 4. Reparse changed/added, grouped by analyzer.
		const errors: { file: string; message: string }[] = [];
		const unitsByAnalyzer = new Map<LanguageAnalyzer, ParsedUnit[]>();
		const inputs: UnitInput[] = [];

		for (const rel of toReparse) {
			const analyzer = relToAnalyzer.get(rel);
			const abs = discovered
				.find((d) => d.analyzer === analyzer)
				?.absByRel.get(rel);
			if (!analyzer || !abs) continue;
			try {
				const source = readFileSync(abs, "utf8");
				const mtimeMs = statSync(abs).mtimeMs;
				const unit = analyzer.parseFile(rel, abs, source);
				(
					unitsByAnalyzer.get(analyzer) ??
					unitsByAnalyzer.set(analyzer, []).get(analyzer)!
				).push(unit);
				inputs.push({
					relPath: rel,
					hash: hashText(source),
					mtimeMs,
					symbols: unit.symbols,
				});
			} catch (err) {
				errors.push({ file: rel, message: (err as Error).message });
			}
		}
		persistUnits(db, inputs);

		// 5. Resolve edges for the reparsed units of each affected analyzer.
		const index = buildNodeIndex(db);
		for (const { analyzer, repoRoot: aRoot } of discovered) {
			const units = unitsByAnalyzer.get(analyzer);
			if (!units || units.length === 0) continue;
			const d = analyzer.discoverFiles(repoRoot); // full current file set
			const out = analyzer.resolveEdges({
				repoRoot: aRoot,
				discovered: {
					repoRoot: aRoot,
					files: d.files,
					options: d.options,
				},
				units,
				allRelPaths: d.files.map((f) => toRelPath(aRoot, f)),
				index,
				carry: opts.carry?.get(analyzer.id),
			});
			persistRouteNodes(db, out.routeNodes);
			persistEdges(db, out.edges);
			persistUnresolved(db, out.unresolved);
			carryOut.set(analyzer.id, out.carry);
		}

		// 6. Restore inbound edges whose endpoints both still exist.
		restoreInbound(db, inbound);

		// 7. Parse errors.
		db.transaction(() => {
			const clear = db.prepare(`DELETE FROM parse_errors WHERE file = ?`);
			const ins = db.prepare(
				`INSERT INTO parse_errors(file, message, at) VALUES(?, ?, ?)`,
			);
			for (const rel of toReparse) clear.run(rel);
			const now = Date.now();
			for (const e of errors) ins.run(e.file, e.message, now);
		})();

		// 8. Metadata.
		writeInputSetHash(db);
		db.prepare(
			`INSERT INTO meta(key, value) VALUES('refreshed_at', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		).run(String(Date.now()));

		return {
			report: countsReport(db, root, {
				added,
				changed,
				removed,
				unchanged,
				elapsedMs: Math.round(performance.now() - started),
				noop: false,
			}),
			carry: carryOut,
		};
	} finally {
		db.close();
	}
}

function restoreInbound(db: DB, edges: EdgeRow[]): void {
	if (edges.length === 0) return;
	const exists = db.prepare(`SELECT 1 FROM nodes WHERE id = ?`);
	const insert = db.prepare(
		`INSERT INTO edges (src, dst, kind, resolution, file, line)
		 VALUES (@src, @dst, @kind, @resolution, @file, @line)
		 ON CONFLICT(src, dst, kind) DO NOTHING`,
	);
	db.transaction((es: EdgeRow[]) => {
		for (const e of es) {
			if (exists.get(e.src) && exists.get(e.dst)) insert.run(e);
		}
	})(edges);
}

function countsReport(
	db: DB,
	root: string,
	base: Omit<
		RefreshReport,
		"repoRoot" | "nodeCount" | "edgeCount" | "unresolvedCount"
	>,
): RefreshReport {
	const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
	return {
		repoRoot: root,
		...base,
		nodeCount: count(`SELECT COUNT(*) AS n FROM nodes`),
		edgeCount: count(`SELECT COUNT(*) AS n FROM edges`),
		unresolvedCount: count(`SELECT COUNT(*) AS n FROM unresolved`),
	};
}
