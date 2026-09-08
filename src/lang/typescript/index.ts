import { resolve } from "node:path";
import type ts from "typescript";
import { discoverFiles } from "../../ingest/discover.js";
import { extractImports } from "../../ingest/imports.js";
import {
	resolveImportEdges,
	routePass,
	type ParsedFile,
} from "../../ingest/passes.js";
import { createProgram, type ProgramBundle } from "../../ingest/program.js";
import { semanticPass } from "../../ingest/semantic.js";
import { structuralParse } from "../../ingest/structural.js";
import { createSymbolIndex } from "../../ingest/symbol-index.js";
import { toRelPath } from "../../store/persist.js";
import type {
	Discovered,
	LanguageAnalyzer,
	ParsedUnit,
	ResolveInput,
	ResolveOutput,
} from "../types.js";

export const typeScriptAnalyzer: LanguageAnalyzer = {
	id: "typescript",
	extensions: [".ts", ".tsx"],

	discoverFiles(repoRoot: string): Discovered {
		try {
			const d = discoverFiles(repoRoot);
			return { repoRoot: d.repoRoot, files: d.files, options: d.options };
		} catch {
			// No tsconfig.json - this repo has no TypeScript for us to analyze.
			return { repoRoot: resolve(repoRoot), files: [] };
		}
	},

	parseFile(relPath, absPath, source): ParsedUnit {
		return {
			relPath,
			absPath,
			symbols: structuralParse(relPath, source).symbols,
			imports: extractImports(relPath, source),
		};
	},

	resolveEdges(input: ResolveInput): ResolveOutput {
		const { repoRoot, discovered, units, allRelPaths, index, carry } =
			input;
		if (units.length === 0) {
			return { edges: [], unresolved: [], routeNodes: [], carry };
		}
		const options = discovered.options as ts.CompilerOptions;

		// Pass 2 - IMPORTS.
		const parsed: ParsedFile[] = units.map((u) => ({
			relPath: u.relPath,
			absPath: u.absPath,
			imports: u.imports,
		}));
		const imports = resolveImportEdges(
			options,
			repoRoot,
			allRelPaths,
			parsed,
		);

		// Passes 3 + 4 - semantic + routes. Program spans every file so the
		// checker resolves cross-file; we only walk `units`.
		const built = createProgram(
			discovered.files,
			options,
			carry as ts.Program | undefined,
		);
		const targetRel = new Set(units.map((u) => u.relPath));
		const scoped: ProgramBundle = {
			program: built.program,
			checker: built.checker,
			sourceFiles: built.sourceFiles.filter((sf) =>
				targetRel.has(toRelPath(repoRoot, sf.fileName)),
			),
		};
		const symbolIndex = createSymbolIndex(repoRoot, index.ids);
		const semantic = semanticPass(
			scoped,
			symbolIndex,
			repoRoot,
			index.idsByName,
		);
		const routes = routePass(scoped, repoRoot, symbolIndex);

		return {
			edges: [...imports.edges, ...semantic.edges, ...routes.edges],
			unresolved: [
				...imports.unresolved,
				...semantic.unresolved,
				...routes.unresolved,
			],
			routeNodes: routes.routeNodes,
			carry: built.program,
		};
	},
};
