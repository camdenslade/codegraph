import type ts from "typescript";
import {
	moduleNodeId,
	nodeId,
	toRelPath,
	type EdgeRow,
	type RouteNodeRow,
	type UnresolvedRow,
} from "../store/persist.js";
import type { LangImport } from "../lang/types.js";
import type { ProgramBundle } from "./program.js";
import { declFromSymbol } from "./resolve-decl.js";
import { createModuleResolver } from "./resolve-module.js";
import { expressExtractor } from "./routes/express.js";
import { reactRouterExtractor } from "./routes/react-router.js";
import type { RouteContext, RouteExtractor } from "./routes/types.js";
import type { SymbolIndex } from "./symbol-index.js";

export interface ParsedFile {
	relPath: string;
	absPath: string;
	imports: LangImport[];
}

/**
 * Resolve every import specifier to a module node, or record it as an unresolved
 * `import`. `allRelPaths` must be the FULL current file set (not just the files
 * being parsed) so cross-file targets resolve during an incremental update.
 */
export function resolveImportEdges(
	options: ts.CompilerOptions,
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

const ROUTE_EXTRACTORS: RouteExtractor[] = [
	expressExtractor,
	reactRouterExtractor,
];

export interface RoutePassResult {
	routeNodes: RouteNodeRow[];
	edges: EdgeRow[];
	unresolved: UnresolvedRow[];
}

/**
 * Run every route extractor over `bundle.sourceFiles`, producing `route` nodes
 * and `HANDLES` edges. Handlers that resolve to a graph node get an edge;
 * inline or unresolvable handlers become unresolved `route` entries so the agent
 * knows to open the file (G5).
 */
export function routePass(
	bundle: ProgramBundle,
	root: string,
	idx: SymbolIndex,
): RoutePassResult {
	const { checker, sourceFiles } = bundle;
	const routeNodes: RouteNodeRow[] = [];
	const edges: EdgeRow[] = [];
	const unresolved: UnresolvedRow[] = [];

	for (const sf of sourceFiles) {
		const relPath = toRelPath(root, sf.fileName);
		const ctx: RouteContext = {
			relPath,
			sourceFile: sf,
			lineOf: (n: ts.Node) =>
				sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
			resolveToNodeId: (expr) => {
				const d = declFromSymbol(
					checker,
					checker.getSymbolAtLocation(expr),
				);
				return d ? idx.idForDeclaration(d) : null;
			},
		};

		for (const extractor of ROUTE_EXTRACTORS) {
			for (const hit of extractor.extract(ctx)) {
				const name = `${hit.method} ${hit.routePath}`;
				const qn = `${relPath}:${name}`;
				const id = nodeId("route", qn);
				routeNodes.push({
					id,
					name,
					qualifiedName: qn,
					file: relPath,
					spanStart: hit.span.start,
					spanEnd: hit.span.end,
					signature: `${hit.framework} ${name}`,
				});

				if (hit.handler.kind === "node") {
					edges.push({
						src: id,
						dst: hit.handler.id,
						kind: "HANDLES",
						resolution: "resolved",
						file: relPath,
						line: hit.line,
					});
				} else {
					unresolved.push({
						nodeId: id,
						kind: "route",
						text:
							hit.handler.kind === "inline"
								? "<inline handler>"
								: hit.handler.text,
						file: relPath,
						line: hit.line,
					});
				}
			}
		}
	}

	return { routeNodes, edges, unresolved };
}
