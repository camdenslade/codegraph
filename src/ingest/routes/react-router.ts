import ts from "typescript";
import {
	type RouteContext,
	type RouteExtractor,
	type RouteHit,
} from "./types.js";

/**
 * React Router. Matches `<Route path="/x" element={<Thing />} />` and
 * `<Route path="/x" Component={Thing} />` (also `component={...}`). The route's
 * "handler" is the component. Object-router config (createBrowserRouter([...]))
 * is deferred to v1.1.
 */
export const reactRouterExtractor: RouteExtractor = {
	name: "react-router",
	extract(ctx) {
		const hits: RouteHit[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isJsxSelfClosingElement(node) ||
				ts.isJsxOpeningElement(node)
			) {
				routeElement(node, ctx, hits);
			}
			ts.forEachChild(node, visit);
		};
		ts.forEachChild(ctx.sourceFile, visit);
		return hits;
	},
};

function routeElement(
	el: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
	ctx: RouteContext,
	hits: RouteHit[],
): void {
	if (!ts.isIdentifier(el.tagName) || el.tagName.text !== "Route") return;

	const attrs = jsxAttrs(el);
	const path = attrs.path && stringOfAttr(attrs.path);
	if (!path) return;

	const compExpr =
		componentFromAttr(attrs.element) ??
		componentFromAttr(attrs.Component) ??
		componentFromAttr(attrs.component);

	hits.push({
		method: "ROUTE",
		routePath: path,
		framework: "react-router",
		line: ctx.lineOf(el),
		span: { start: el.getStart(ctx.sourceFile), end: el.getEnd() },
		handler: compExpr
			? classifyComponent(compExpr, ctx)
			: { kind: "unresolved", text: "<no element/component>" },
	});
}

function classifyComponent(
	expr: ts.Expression,
	ctx: RouteContext,
): RouteHit["handler"] {
	const id = ctx.resolveToNodeId(expr);
	if (id) return { kind: "node", id };
	return {
		kind: "unresolved",
		text: expr.getText(ctx.sourceFile).slice(0, 80),
	};
}

/** `element={<Thing />}` -> the `Thing` identifier; `Component={Thing}` -> `Thing`. */
function componentFromAttr(
	attr: ts.JsxAttribute | undefined,
): ts.Expression | undefined {
	if (!attr || !attr.initializer) return undefined;
	if (!ts.isJsxExpression(attr.initializer)) return undefined;
	const inner = attr.initializer.expression;
	if (!inner) return undefined;
	if (ts.isJsxSelfClosingElement(inner) && ts.isIdentifier(inner.tagName)) {
		return inner.tagName;
	}
	if (
		ts.isJsxElement(inner) &&
		ts.isIdentifier(inner.openingElement.tagName)
	) {
		return inner.openingElement.tagName;
	}
	if (ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner)) {
		return inner;
	}
	return undefined;
}

function jsxAttrs(
	el: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
): Record<string, ts.JsxAttribute | undefined> {
	const out: Record<string, ts.JsxAttribute | undefined> = {};
	for (const a of el.attributes.properties) {
		if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name)) {
			out[a.name.text] = a;
		}
	}
	return out;
}

function stringOfAttr(attr: ts.JsxAttribute): string | null {
	const init = attr.initializer;
	if (!init) return null;
	if (ts.isStringLiteral(init)) return init.text;
	if (
		ts.isJsxExpression(init) &&
		init.expression &&
		ts.isStringLiteral(init.expression)
	) {
		return init.expression.text;
	}
	return null;
}
