import { performance } from "node:perf_hooks";
import { openDB } from "../store/db.js";
import {
	hashText,
	persistEdges,
	persistFiles,
	persistUnresolved,
} from "../store/persist.js";
import { discoverFiles } from "./discover.js";
import { createProgram } from "./program.js";
import { parseFiles, resolveImportEdges, runSemantic } from "./passes.js";

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

export function ingest(
	repoRoot: string,
	opts: IngestOptions = {},
): IngestReport {
	const started = performance.now();
	const discovered = discoverFiles(repoRoot);
	const root = discovered.repoRoot;
	const db = openDB(root, { fresh: opts.fresh ?? false });

	// Pass 0: read, hash, structural-parse, extract imports.
	const { inputs, parsed, errors } = parseFiles(root, discovered.files);

	// Pass 1: files, nodes, DECLARES edges.
	persistFiles(db, inputs);

	// Pass 2: IMPORTS edges — every module node now exists.
	const imports = resolveImportEdges(
		discovered.options,
		root,
		inputs.map((i) => i.relPath),
		parsed,
	);
	persistEdges(db, imports.edges);
	persistUnresolved(db, imports.unresolved);

	// Pass 3: semantic edges (CALLS / REFERENCES / EXTENDS / IMPLEMENTS) over
	// every file.
	const bundle = createProgram(discovered.files, discovered.options);
	const semantic = runSemantic(bundle, root, db);
	persistEdges(db, semantic.edges);
	persistUnresolved(db, semantic.unresolved);

	// Parse errors.
	const recordErrors = db.transaction(() => {
		const clear = db.prepare(`DELETE FROM parse_errors WHERE file = ?`);
		const ins = db.prepare(
			`INSERT INTO parse_errors(file, message, at) VALUES(?, ?, ?)`,
		);
		const now = Date.now();
		for (const e of errors) {
			clear.run(e.file);
			ins.run(e.file, e.message, now);
		}
	});
	recordErrors();

	// Metadata.
	const elapsedMs = Math.round(performance.now() - started);
	const inputSetHash = hashText(
		inputs
			.map((i) => `${i.relPath}:${i.hash}`)
			.sort()
			.join("\n"),
	);
	const setMeta = db.prepare(
		`INSERT INTO meta(key, value) VALUES(?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	setMeta.run("repo_root", root);
	setMeta.run("input_set_hash", inputSetHash);
	setMeta.run("ingested_at", String(Date.now()));
	setMeta.run("ingest_ms", String(elapsedMs));

	const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
	const report: IngestReport = {
		repoRoot: root,
		filesDiscovered: discovered.files.length,
		filesParsed: inputs.length,
		filesErrored: errors.length,
		nodeCount: count(`SELECT COUNT(*) AS n FROM nodes`),
		edgeCount: count(`SELECT COUNT(*) AS n FROM edges`),
		unresolvedCount: count(`SELECT COUNT(*) AS n FROM unresolved`),
		elapsedMs,
	};

	db.close();
	return report;
}
