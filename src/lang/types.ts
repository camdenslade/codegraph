import type { EdgeRow, RouteNodeRow, UnresolvedRow } from "../store/persist.js";

/** Symbol kinds across languages. Stored verbatim in nodes.kind. */
export type SymbolKind =
	| "function"
	| "method"
	| "class"
	| "interface"
	| "type-alias"
	| "enum"
	| "variable"
	| "record";

/** A declared symbol, language-neutral. Byte offsets, 1-based line. */
export interface LangSymbol {
	kind: SymbolKind;
	name: string;
	container?: string; // enclosing class, for methods
	spanStart: number;
	spanEnd: number;
	line: number;
	signature: string; // no body
	doc?: string;
	/** TS: has an `export`. Java: public/protected visibility. */
	exported: boolean;
}

export interface LangImport {
	specifier: string; // TS module specifier | Java FQN or "pkg.*"
	kind: "import" | "export-from";
	names: string[];
	isTypeOnly: boolean;
	line: number;
}

export interface ParsedUnit {
	relPath: string;
	absPath: string;
	symbols: LangSymbol[];
	imports: LangImport[];
	/** Analyzer-private per-file metadata (e.g. Java package name). */
	meta?: unknown;
}

export interface Discovered {
	repoRoot: string;
	files: string[]; // absolute
	/** Analyzer-private extras carried to resolveEdges (e.g. TS CompilerOptions). */
	options?: unknown;
}

/** The current graph's nodes, for cross-file resolution. Built by core from SQLite. */
export interface NodeIndex {
	ids: string[];
	has(id: string): boolean;
	/** callable name -> node ids (function/method) - TS CALLS heuristic */
	idsByName: Map<string, string[]>;
	/** type name -> node ids (class/interface/enum/record) - Java heritage */
	typeIdsByName: Map<string, string[]>;
	/** qualified_name -> node id */
	idByQualifiedName: Map<string, string>;
}

export interface ResolveInput {
	repoRoot: string;
	discovered: Discovered;
	/** Units whose edges we (re)resolve; every file on a full ingest. */
	units: ParsedUnit[];
	/** Every current rel path for this language (for cross-file targets). */
	allRelPaths: string[];
	index: NodeIndex;
	/** Analyzer-private state from a previous run (e.g. a warm ts.Program). */
	carry?: unknown;
}

export interface ResolveOutput {
	edges: EdgeRow[];
	unresolved: UnresolvedRow[];
	routeNodes: RouteNodeRow[];
	/** Analyzer-private state to reuse next run. */
	carry?: unknown;
}

export interface LanguageAnalyzer {
	id: string; // "typescript" | "java"
	extensions: string[]; // [".ts", ".tsx"]
	discoverFiles(repoRoot: string): Discovered;
	parseFile(relPath: string, absPath: string, source: string): ParsedUnit;
	resolveEdges(input: ResolveInput): ResolveOutput;
}
