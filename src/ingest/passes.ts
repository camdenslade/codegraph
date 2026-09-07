import { readFileSync, statSync } from "node:fs";
import type { DB } from "../store/db.js";
import {
	hashText,
	moduleNodeId,
	toRelPath,
	type EdgeRow,
	type PersistInput,
	type UnresolvedRow,
} from "../store/persist.js";
import { extractImports, type ImportRef } from "./imports.js";
import type { ProgramBundle } from "./program.js";
import { createModuleResolver } from "./resolve-module.js";
import { semanticPass, type SemanticResult } from "./semantic.js";
import { structuralParse } from "./structural.js";
import { createSymbolIndex } from "./symbol-index.js";

export interface ParsedFile {
	relPath: string;
	absPath: string;
	imports: ImportRef[];
}

export interface ParseResult {
	inputs: PersistInput[];
	parsed: ParsedFile[];
	errors: { file: string; message: string }[];
}

/**
 * Read + hash + structural-parse + import-extract a set of absolute file paths.
 * A file that throws anywhere in here is recorded and skipped (NFR-4), never fatal.
 * Shared by the full ingest and the incremental update so both build identical
 * node/import data from the same code.
 */
export function parseFiles(root: string, absFiles: string[]): ParseResult {
	const inputs: PersistInput[] = [];
	const parsed: ParsedFile[] = [];
	const errors: { file: string; message: string }[] = [];

	for (const absPath of absFiles) {
		const relPath = toRelPath(root, absPath);
		try {
			const source = readFileSync(absPath, "utf8");
			const mtimeMs = statSync(absPath).mtimeMs;
			inputs.push({
				relPath,
				hash: hashText(source),
				mtimeMs,
				structural: structuralParse(relPath, source),
			});
			parsed.push({
				relPath,
				absPath,
				imports: extractImports(relPath, source),
			});
		} catch (err) {
			errors.push({ file: relPath, message: (err as Error).message });
		}
	}
	return { inputs, parsed, errors };
}

/**
 * Resolve every import specifier in `parsed` to a module node, or record it as
 * an unresolved `import`. `allRelPaths` must be the FULL current file set (not
 * just the files being parsed) so cross-file targets resolve during an
 * incremental update.
 */
export function resolveImportEdges(
	options: import("typescript").CompilerOptions,
	root: string,
	allRelPaths: string[],
	parsed: ParsedFile[],
): { edges: EdgeRow[]; unresolved: UnresolvedRow[] } {
	const resolver = createModuleResolver(options, root, allRelPaths);
	const edges: EdgeRow[] = [];
	const unresolved: UnresolvedRow[] = [];

	for (const { relPath, absPath, imports } of parsed) {
		const srcId = moduleNodeId(relPath);
		for (const ref of imports) {
			const target = resolver.resolve(ref.specifier, absPath);
			if (target) {
				edges.push({
					src: srcId,
					dst: moduleNodeId(target),
					kind: "IMPORTS",
					resolution: "resolved",
					file: relPath,
					line: ref.line,
				});
			} else {
				unresolved.push({
					nodeId: srcId,
					kind: "import",
					text: ref.specifier,
					file: relPath,
					line: ref.line,
				});
			}
		}
	}
	return { edges, unresolved };
}

/** Name -> callable node ids, for the semantic pass's heuristic fallback. */
export function buildNameIndex(db: DB): Map<string, string[]> {
	const nameIndex = new Map<string, string[]>();
	const rows = db
		.prepare(
			`SELECT id, name FROM nodes WHERE kind IN ('function', 'method')`,
		)
		.all() as { id: string; name: string }[];
	for (const { id, name } of rows) {
		const arr = nameIndex.get(name) ?? [];
		arr.push(id);
		nameIndex.set(name, arr);
	}
	return nameIndex;
}

/**
 * Run the semantic pass over `bundle.sourceFiles` (the caller decides whether
 * that's every file or just the changed ones) using the current node set for
 * resolution.
 */
export function runSemantic(
	bundle: ProgramBundle,
	root: string,
	db: DB,
): SemanticResult {
	const allIds = (
		db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]
	).map((r) => r.id);
	const symbolIndex = createSymbolIndex(root, allIds);
	return semanticPass(bundle, symbolIndex, root, buildNameIndex(db));
}
