import ts from "typescript";
import {
	classifyHandler,
	type RouteContext,
	type RouteExtractor,
	type RouteHit,
} from "./types.js";

const HTTP_METHODS = new Set([
	"get",
	"post",
	"put",
	"delete",
	"patch",
	"options",
	"head",
	"all",
]);

/**
 * Express / Fastify. Matches `x.get("/path", ...handlers)` for any HTTP verb
 * (covers `app.get`, `router.post`, `fastify.get`, ...) and Fastify's
 * `x.route({ method, url, handler })` object form. The last function argument
 * of a verb call is taken as the handler.
 */
export const expressExtractor: RouteExtractor = {
	name: "express",
	extract(ctx) {
		const hits: RouteHit[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				verbCall(node, ctx, hits);
				fastifyRouteCall(node, ctx, hits);
			}
			ts.forEachChild(node, visit);
		};
		ts.forEachChild(ctx.sourceFile, visit);
		return hits;
	},
};

function verbCall(
	call: ts.CallExpression,
	ctx: RouteContext,
	hits: RouteHit[],
): void {
	const callee = call.expression;
	if (!ts.isPropertyAccessExpression(callee)) return;
	const method = callee.name.text.toLowerCase();
	if (!HTTP_METHODS.has(method)) return;

	const [pathArg, ...rest] = call.arguments;
	if (!pathArg || !isStringLike(pathArg)) return;
	const handlerArg = rest[rest.length - 1];
	if (!handlerArg) return;

	hits.push({
		method: method.toUpperCase(),
		routePath: pathArg.text,
		framework: "express",
		line: ctx.lineOf(call),
		span: { start: call.getStart(ctx.sourceFile), end: call.getEnd() },
		handler: classifyHandler(handlerArg, ctx),
	});
}

function fastifyRouteCall(
	call: ts.CallExpression,
	ctx: RouteContext,
	hits: RouteHit[],
): void {
	const callee = call.expression;
	if (
		!ts.isPropertyAccessExpression(callee) ||
		callee.name.text !== "route"
	) {
		return;
	}
	const arg = call.arguments[0];
	if (!arg || !ts.isObjectLiteralExpression(arg)) return;

	const props = objectProps(arg);
	const url = stringOf(props.url);
	if (!url) return;
	const method = (stringOf(props.method) ?? "GET").toUpperCase();

	hits.push({
		method,
		routePath: url,
		framework: "fastify",
		line: ctx.lineOf(call),
		span: { start: call.getStart(ctx.sourceFile), end: call.getEnd() },
		handler: props.handler
			? classifyHandler(props.handler, ctx)
			: { kind: "unresolved", text: "<no handler property>" },
	});
}

function isStringLike(
	n: ts.Expression,
): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
	return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
}

function objectProps(
	obj: ts.ObjectLiteralExpression,
): Record<string, ts.Expression | undefined> {
	const out: Record<string, ts.Expression | undefined> = {};
	for (const p of obj.properties) {
		if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
			out[p.name.text] = p.initializer;
		}
	}
	return out;
}

function stringOf(e: ts.Expression | undefined): string | null {
	return e && isStringLike(e) ? e.text : null;
}
