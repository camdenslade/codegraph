import ts from "typescript";
import { toRelPath } from "../../store/persist.js";
import type { ProgramBundle } from "../../ingest/program.js";
import type { SymbolIndex } from "../../ingest/symbol-index.js";
import type { EndpointCall } from "../types.js";

const AXIOS_METHODS = new Set([
	"get",
	"post",
	"put",
	"delete",
	"patch",
	"head",
]);
// Bare call names that take a URL as their first argument.
const URL_FNS = new Set([
	"fetch",
	"apiRequest",
	"request",
	"useSWR",
	"useQuery",
]);

/**
 * Client HTTP calls: `fetch("/api/x")`, `axios.post("/api/x", body)`,
 * `apiRequest("/api/x", { method })`. Extracts the verb and the URL path (path
 * params and `${...}` interpolations normalized to `*`) plus the enclosing
 * symbol, for later matching against route nodes.
 */
export function extractEndpointCalls(
	bundle: ProgramBundle,
	repoRoot: string,
	idx: SymbolIndex,
): EndpointCall[] {
	const out: EndpointCall[] = [];

	for (const sf of bundle.sourceFiles) {
		const rel = toRelPath(repoRoot, sf.fileName);
		const ownerStack: string[] = [`module:${rel}`];
		const owner = () => ownerStack[ownerStack.length - 1]!;

		const visit = (node: ts.Node): void => {
			const pushed = ownerIdFor(node, idx);
			if (pushed) ownerStack.push(pushed);

			if (ts.isCallExpression(node)) {
				const hit = classifyCall(node);
				if (hit) {
					out.push({
						ownerId: owner(),
						method: hit.method,
						path: hit.path,
						file: rel,
						line:
							sf.getLineAndCharacterOfPosition(node.getStart(sf))
								.line + 1,
					});
				}
			}

			ts.forEachChild(node, visit);
			if (pushed) ownerStack.pop();
		};
		ts.forEachChild(sf, visit);
	}
	return out;
}

function classifyCall(
	call: ts.CallExpression,
): { method: string; path: string } | null {
	const callee = call.expression;

	// axios.post("/x", ...) / client.get("/x")
	if (
		ts.isPropertyAccessExpression(callee) &&
		AXIOS_METHODS.has(callee.name.text)
	) {
		const path = urlArg(call.arguments[0]);
		return path ? { method: callee.name.text.toUpperCase(), path } : null;
	}

	// fetch("/x", { method }) / apiRequest("/x", { method })
	const name = ts.isIdentifier(callee)
		? callee.text
		: ts.isPropertyAccessExpression(callee)
			? callee.name.text
			: null;
	if (name && URL_FNS.has(name)) {
		const path = urlArg(call.arguments[0]);
		if (!path) return null;
		return { method: methodFromOptions(call.arguments[1]) ?? "GET", path };
	}
	return null;
}

/** A string / template-literal argument -> a normalized URL path, or null. */
function urlArg(arg: ts.Expression | undefined): string | null {
	if (!arg) return null;
	let raw: string | null = null;
	if (ts.isStringLiteralLike(arg)) {
		raw = arg.text;
	} else if (ts.isTemplateExpression(arg)) {
		raw =
			arg.head.text +
			arg.templateSpans.map((s) => `*${s.literal.text}`).join("");
	} else if (ts.isNoSubstitutionTemplateLiteral(arg)) {
		raw = arg.text;
	}
	if (raw === null) return null;

	// strip origin and query, keep the path
	raw = raw.replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
	if (!raw.includes("/api")) return null;
	raw = raw.slice(raw.indexOf("/api"));
	return normalizePath(raw);
}

function methodFromOptions(arg: ts.Expression | undefined): string | null {
	if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
	for (const p of arg.properties) {
		if (
			ts.isPropertyAssignment(p) &&
			ts.isIdentifier(p.name) &&
			p.name.text === "method" &&
			ts.isStringLiteralLike(p.initializer)
		) {
			return p.initializer.text.toUpperCase();
		}
	}
	return null;
}

/** `/api/users/:id` / `/api/users/{id}` / `/api/users/*` all -> `/api/users/*` */
export function normalizePath(p: string): string {
	const segs = p
		.split("/")
		.filter(Boolean)
		.map((s) =>
			/^[:{]/.test(s) || s.includes("*") || /^\$/.test(s) ? "*" : s,
		);
	return `/${segs.join("/")}`;
}

function ownerIdFor(node: ts.Node, idx: SymbolIndex): string | null {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isClassDeclaration(node)
	) {
		return idx.idForDeclaration(node);
	}
	if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
		const p = node.parent;
		if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
			return idx.idForDeclaration(p);
		}
	}
	return null;
}
