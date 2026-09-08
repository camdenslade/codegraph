import ts from "typescript";
import {
	type RouteContext,
	type RouteExtractor,
	type RouteHit,
} from "./types.js";

// Wrapper components that are not the "page" a route renders.
const WRAPPERS = new Set([
	"ProtectedRoute",
	"PrivateRoute",
	"PublicRoute",
	"RequireAuth",
	"AuthGuard",
	"RouteGuard",
	"Suspense",
	"Layout",
	"AppLayout",
	"MainLayout",
	"Outlet",
	"Fragment",
	"ErrorBoundary",
]);

/**
 * React Router. Matches JSX `<Route path element/component>` (unwrapping guard
 * components like ProtectedRoute to the real page) and flat object config
 * `createBrowserRouter([{ path, element }])` / `useRoutes([...])`. Nested
 * `children` path composition is not done.
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
			} else if (ts.isObjectLiteralExpression(node)) {
				routeObject(node, ctx, hits);
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
		componentFrom(attrs.element?.initializer) ??
		componentFrom(attrs.Component?.initializer) ??
		componentFrom(attrs.component?.initializer);

	pushRoute(el, ctx, hits, path, compExpr);
}

function routeObject(
	obj: ts.ObjectLiteralExpression,
	ctx: RouteContext,
	hits: RouteHit[],
): void {
	const props = objProps(obj);
	const path = props.path && stringOfExpr(props.path);
	if (!path) return;
	if (!props.element && !props.Component && !props.component && !props.lazy) {
		return; // a plain object that happens to have a "path" key
	}
	const compExpr =
		componentFrom(props.element) ??
		componentFrom(props.Component) ??
		componentFrom(props.component) ??
		componentFrom(props.lazy);
	pushRoute(obj, ctx, hits, path, compExpr);
}

function pushRoute(
	node: ts.Node,
	ctx: RouteContext,
	hits: RouteHit[],
	path: string,
	compExpr: ts.Expression | undefined,
): void {
	hits.push({
		method: "ROUTE",
		routePath: path,
		framework: "react-router",
		line: ctx.lineOf(node),
		span: { start: node.getStart(ctx.sourceFile), end: node.getEnd() },
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

/**
 * The page component referenced by an `element` / `Component` value: the last
 * non-wrapper PascalCase JSX tag, or a bare identifier / property access.
 * Unwraps `<ProtectedRoute><Dues /></ProtectedRoute>` to `Dues`.
 */
function componentFrom(
	node: ts.Expression | undefined,
): ts.Expression | undefined {
	if (!node) return undefined;
	let inner: ts.Node = node;
	if (ts.isJsxExpression(inner)) {
		if (!inner.expression) return undefined;
		inner = inner.expression;
	}
	if (
		(ts.isIdentifier(inner) && /^[A-Z]/.test(inner.text)) ||
		ts.isPropertyAccessExpression(inner)
	) {
		return inner as ts.Expression;
	}
	// `lazy: () => import("./Page")` -> the module specifier
	if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
		let spec: ts.Expression | undefined;
		const findImport = (n: ts.Node) => {
			if (
				ts.isCallExpression(n) &&
				n.expression.kind === ts.SyntaxKind.ImportKeyword &&
				n.arguments[0] &&
				ts.isStringLiteralLike(n.arguments[0])
			) {
				spec = n.arguments[0];
			}
			ts.forEachChild(n, findImport);
		};
		findImport(inner);
		return spec;
	}

	const tags: ts.Identifier[] = [];
	const walk = (n: ts.Node) => {
		if (
			(ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
			ts.isIdentifier(n.tagName) &&
			/^[A-Z]/.test(n.tagName.text)
		) {
			tags.push(n.tagName);
		}
		ts.forEachChild(n, walk);
	};
	walk(inner);
	const pages = tags.filter((t) => !WRAPPERS.has(t.text));
	return (pages[pages.length - 1] ?? tags[tags.length - 1]) as
		ts.Expression | undefined;
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

function objProps(
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

function stringOfAttr(attr: ts.JsxAttribute): string | null {
	return attr.initializer ? stringOfExpr(attr.initializer) : null;
}

function stringOfExpr(node: ts.Node): string | null {
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isJsxExpression(node) && node.expression) {
		return stringOfExpr(node.expression);
	}
	return null;
}
