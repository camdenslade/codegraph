import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type ts from "typescript";
import { openDB, type DB } from "../store/db.js";
import {
	hashText,
	persistEdges,
	persistFiles,
	persistUnresolved,
	toRelPath,
	type EdgeRow,
} from "../store/persist.js";
import { discoverFiles } from "./discover.js";
import { parseFiles, resolveImportEdges, runSemantic } from "./passes.js";
import { createProgram, type ProgramBundle } from "./program.js";

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
	/** Reuse a warm Program (watch mode) for a much faster TS rebuild. */
	previousProgram?: ts.Program;
}

export interface RefreshOutcome {
	report: RefreshReport;
	/** The Program built this run, or undefined on a no-op. Watch mode keeps it. */
	program: ts.Program | undefined;
}

/**
 * Re-scan the repo, reparse only files whose content hash changed (or are new),
 * and drop files that disappeared. Inbound edges from files we do NOT reparse
 * are snapshotted and restored, so a change to X keeps `A -> X` for unchanged A
 * without reprocessing A. Full re-resolution of importers is deferred to a full
 * `ingest` (FR-INC-2).
 */
export function incrementalUpdate(
	repoRoot: string,
	opts: RefreshOptions = {},
): RefreshOutcome {
	const started = performance.now();
	const discovered = discoverFiles(repoRoot);
	const root = discovered.repoRoot;
	const db = openDB(root);

	try {
		// 1. Diff current files against the stored hashes.
		const stored = new Map(
			(
				db.prepare(`SELECT path, hash FROM files`).all() as {
					path: string;
					hash: string;
				}[]
			).map((r) => [r.path, r.hash] as const),
		);

		const currentRel = new Set<string>();
		const absByRel = new Map<string, string>();
		const added: string[] = [];
		const changed: string[] = [];
		let unchanged = 0;

		for (const abs of discovered.files) {
			const rel = toRelPath(root, abs);
			currentRel.add(rel);
			absByRel.set(rel, abs);
			let hash: string;
			try {
				hash = hashText(readFileSync(abs, "utf8"));
			} catch {
				continue; // unreadable right now; leave whatever we had
			}
			const prev = stored.get(rel);
			if (prev === undefined) added.push(rel);
			else if (prev !== hash) changed.push(rel);
			else unchanged++;
		}
		const removed = [...stored.keys()].filter((p) => !currentRel.has(p));
		const toReparse = [...added, ...changed];

		if (toReparse.length === 0 && removed.length === 0) {
			const report = countsReport(db, root, {
				added,
				changed,
				removed,
				unchanged,
				elapsedMs: Math.round(performance.now() - started),
				noop: true,
			});
			return { report, program: undefined };
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

		// 3. Drop vanished files; cascade clears their nodes/edges/unresolved.
		const dropFile = db.prepare(`DELETE FROM files WHERE path = ?`);
		db.transaction((paths: string[]) => {
			for (const p of paths) dropFile.run(p);
		})(removed);

		// 4. Reparse changed/added. persistFiles deletes each file's old nodes
		//    first, so its outbound edges + unresolved go with them.
		const { inputs, parsed, errors } = parseFiles(
			root,
			toReparse.map((rel) => absByRel.get(rel)!),
		);
		persistFiles(db, inputs);

		// 5. IMPORTS for reparsed files (resolver sees the full current set).
		const imports = resolveImportEdges(
			discovered.options,
			root,
			[...currentRel],
			parsed,
		);
		persistEdges(db, imports.edges);
		persistUnresolved(db, imports.unresolved);

		// 6. Semantic pass: full Program (checker needs every file), but walk
		//    only the reparsed files.
		const built = createProgram(
			discovered.files,
			discovered.options,
			opts.previousProgram,
		);
		const reparseSet = new Set(toReparse);
		const scoped: ProgramBundle = {
			program: built.program,
			checker: built.checker,
			sourceFiles: built.sourceFiles.filter((sf) =>
				reparseSet.has(toRelPath(root, sf.fileName)),
			),
		};
		const semantic = runSemantic(scoped, root, db);
		persistEdges(db, semantic.edges);
		persistUnresolved(db, semantic.unresolved);

		// 7. Restore inbound edges whose endpoints both still exist.
		restoreInbound(db, inbound);

		// 8. Parse errors for the reparsed set.
		db.transaction(() => {
			const clear = db.prepare(`DELETE FROM parse_errors WHERE file = ?`);
			const ins = db.prepare(
				`INSERT INTO parse_errors(file, message, at) VALUES(?, ?, ?)`,
			);
			for (const rel of toReparse) clear.run(rel);
			const now = Date.now();
			for (const e of errors) ins.run(e.file, e.message, now);
		})();

		// 9. Metadata.
		refreshMeta(db);

		const report = countsReport(db, root, {
			added,
			changed,
			removed,
			unchanged,
			elapsedMs: Math.round(performance.now() - started),
			noop: false,
		});
		return { report, program: built.program };
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

function refreshMeta(db: DB): void {
	const rows = db.prepare(`SELECT path, hash FROM files`).all() as {
		path: string;
		hash: string;
	}[];
	const inputSetHash = hashText(
		rows
			.map((r) => `${r.path}:${r.hash}`)
			.sort()
			.join("\n"),
	);
	const set = db.prepare(
		`INSERT INTO meta(key, value) VALUES(?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	set.run("input_set_hash", inputSetHash);
	set.run("refreshed_at", String(Date.now()));
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
