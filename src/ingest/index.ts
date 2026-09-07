import { readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { openDB } from "../store/db.js";
import {
	hashText,
	moduleNodeId,
	persistEdges,
	persistFiles,
	persistUnresolved,
	toRelPath,
	type EdgeRow,
	type PersistInput,
	type UnresolvedRow,
} from "../store/persist.js";
import { discoverFiles } from "./discover.js";
import { extractImports, type ImportRef } from "./imports.js";
import { createModuleResolver } from "./resolve-module.js";
import { structuralParse } from "./structural.js";
import { createProgram } from "./program.js";
import { semanticPass } from "./semantic.js";
import { createSymbolIndex } from "./symbol-index.js";

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

interface FileImports {
	relPath: string;
	absPath: string;
	imports: ImportRef[];
}

export function ingest(
	repoRoot: string,
	opts: IngestOptions = {},
): IngestReport {
	const started = performance.now();
	const discovered = discoverFiles(repoRoot);
	const root = discovered.repoRoot;
	const db = openDB(root, { fresh: opts.fresh ?? false });

	const inputs: PersistInput[] = [];
	const fileImports: FileImports[] = [];
	const errors: { file: string; message: string }[] = [];

	for (const abs of discovered.files) {
		const relPath = toRelPath(root, abs);
		try {
			const source = readFileSync(abs, "utf8");
			const mtimeMs = statSync(abs).mtimeMs;
			const structural = structuralParse(relPath, source);
			inputs.push({
				relPath,
				hash: hashText(source),
				mtimeMs,
				structural,
			});
			fileImports.push({
				relPath,
				absPath: abs,
				imports: extractImports(relPath, source),
			});
		} catch (err) {
			errors.push({ file: relPath, message: (err as Error).message });
		}
	}

	// Pass 1: files, nodes, DECLARES edges.
	persistFiles(db, inputs);

	// Pass 2: IMPORTS edges — needs every module node to already exist.
	const resolver = createModuleResolver(
		discovered.options,
		root,
		inputs.map((i) => i.relPath),
	);
	const importEdges: EdgeRow[] = [];
	const importUnresolved: UnresolvedRow[] = [];
	for (const { relPath, absPath, imports } of fileImports) {
		const srcId = moduleNodeId(relPath);
		for (const ref of imports) {
			const target = resolver.resolve(ref.specifier, absPath);
			if (target) {
				importEdges.push({
					src: srcId,
					dst: moduleNodeId(target),
					kind: "IMPORTS",
					resolution: "resolved",
					file: relPath,
					line: ref.line,
				});
			} else {
				importUnresolved.push({
					nodeId: srcId,
					kind: "import",
					text: ref.specifier,
					file: relPath,
					line: ref.line,
				});
			}
		}
	}
	persistEdges(db, importEdges);
	persistUnresolved(db, importUnresolved);

	// Pass 3: semantic edges (CALLS / REFERENCES / EXTENDS / IMPLEMENTS).
	const bundle = createProgram(discovered.files, discovered.options);
	const allIds = (
		db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]
	).map((r) => r.id);
	const symbolIndex = createSymbolIndex(root, allIds);

	const nameIndex = new Map<string, string[]>();
	for (const row of db
		.prepare(
			`SELECT id, name FROM nodes WHERE kind IN ('function', 'method')`,
		)
		.all() as { id: string; name: string }[]) {
		const arr = nameIndex.get(row.name) ?? [];
		arr.push(row.id);
		nameIndex.set(row.name, arr);
	}

	const semantic = semanticPass(bundle, symbolIndex, root, nameIndex);
	persistEdges(db, semantic.edges);
	persistUnresolved(db, semantic.unresolved);

	// Metadata + counts.
	const elapsedMs = Math.round(performance.now() - started);
	const inputSetHash = hashText(
		inputs
			.map((i) => `${i.relPath}:${i.hash}`)
			.sort()
			.join("\n"),
	);

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
