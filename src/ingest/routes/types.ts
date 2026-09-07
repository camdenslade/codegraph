import ts from "typescript";

/** One route declaration found in a source file. */
export interface RouteHit {
	/** HTTP verb (GET/POST/...) or "ROUTE" for a router-only match. */
	method: string;
	/** The URL pattern, verbatim: "/users/:id". */
	routePath: string;
	framework: string;
	line: number;
	span: { start: number; end: number };
	handler:
		| { kind: "node"; id: string } // resolved to a graph node
		| { kind: "inline" } // an inline arrow/function expression
		| { kind: "unresolved"; text: string }; // named, but not resolvable
}

export interface RouteContext {
	relPath: string;
	sourceFile: ts.SourceFile;
	lineOf(node: ts.Node): number;
	/** Resolve an expression to one of our node ids, or null. */
	resolveToNodeId(expr: ts.Expression): string | null;
}

export interface RouteExtractor {
	name: string;
	extract(ctx: RouteContext): RouteHit[];
}

/** Shared: classify a handler argument expression. */
export function classifyHandler(
	expr: ts.Expression,
	ctx: RouteContext,
): RouteHit["handler"] {
	if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
		return { kind: "inline" };
	}
	const id = ctx.resolveToNodeId(expr);
	if (id) return { kind: "node", id };
	return {
		kind: "unresolved",
		text: expr.getText(ctx.sourceFile).slice(0, 80),
	};
}
