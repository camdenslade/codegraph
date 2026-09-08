import type Parser from "tree-sitter";
import {
	nodeId,
	type EdgeRow,
	type RouteNodeRow,
} from "../../store/persist.js";

type SyntaxNode = Parser.SyntaxNode;

const VERB: Record<string, string> = {
	GetMapping: "GET",
	PostMapping: "POST",
	PutMapping: "PUT",
	DeleteMapping: "DELETE",
	PatchMapping: "PATCH",
};

/**
 * Spring MVC routes: `@GetMapping` / `@PostMapping` / ... / `@RequestMapping` on
 * a controller method, prefixed by the class-level `@RequestMapping` path. Emits
 * a `route` node and a `HANDLES` edge to the annotated method.
 */
export function extractSpringRoutes(
	root: SyntaxNode,
	relPath: string,
	has: (id: string) => boolean,
): { routeNodes: RouteNodeRow[]; edges: EdgeRow[] } {
	const routeNodes: RouteNodeRow[] = [];
	const edges: EdgeRow[] = [];

	const visit = (node: SyntaxNode, classBase: string): void => {
		if (
			node.type === "class_declaration" ||
			node.type === "interface_declaration"
		) {
			const className =
				node.childForFieldName("name")?.text ??
				node.namedChildren.find((c) => c.type === "identifier")?.text;
			const base = joinPath(classBase, mappingPath(node) ?? "");
			const body = node.namedChildren.find((c) =>
				c.type.endsWith("_body"),
			);
			for (const m of body?.namedChildren ?? []) {
				if (m.type === "method_declaration" && className) {
					handleMethod(m, className, base);
				} else {
					visit(m, base); // nested type
				}
			}
			return;
		}
		for (const c of node.namedChildren) visit(c, classBase);
	};

	const handleMethod = (
		method: SyntaxNode,
		className: string,
		classBase: string,
	): void => {
		const ann = mappingAnnotation(method);
		if (!ann) return;
		const verb = httpVerb(ann);
		const path = joinPath(classBase, mappingPath(ann) ?? "");
		const methodName = method.childForFieldName("name")?.text;
		if (!methodName) return;

		const handlerId = nodeId(
			"method",
			`${relPath}:${className}.${methodName}`,
		);
		const name = `${verb} ${path}`;
		const qn = `${relPath}:${name}`;
		const routeId = nodeId("route", qn);

		routeNodes.push({
			id: routeId,
			name,
			qualifiedName: qn,
			file: relPath,
			spanStart: method.startIndex,
			spanEnd: method.endIndex,
			signature: `spring ${name}`,
		});
		if (has(handlerId)) {
			edges.push({
				src: routeId,
				dst: handlerId,
				kind: "HANDLES",
				resolution: "resolved",
				file: relPath,
				line: method.startPosition.row + 1,
			});
		}
	};

	visit(root, "");
	return { routeNodes, edges };
}

/** The mapping annotation on a class or method, or null. */
function mappingAnnotation(node: SyntaxNode): SyntaxNode | null {
	const mods = node.namedChildren.find((c) => c.type === "modifiers");
	for (const a of mods?.namedChildren ?? []) {
		if (a.type !== "annotation" && a.type !== "marker_annotation") continue;
		const nm = a.namedChildren.find((c) => c.type === "identifier")?.text;
		if (nm && (nm in VERB || nm === "RequestMapping")) return a;
	}
	return null;
}

function httpVerb(ann: SyntaxNode): string {
	const nm =
		ann.namedChildren.find((c) => c.type === "identifier")?.text ?? "";
	if (nm in VERB) return VERB[nm]!;
	// @RequestMapping(method = RequestMethod.POST)
	const m = argValue(ann, "method");
	const verb = m?.split(".").pop();
	return verb && /^[A-Z]+$/.test(verb) ? verb : "ANY";
}

/** The path string from a mapping annotation ("value" / "path" / positional). */
function mappingPath(node: SyntaxNode): string | null {
	const ann =
		node.type === "annotation" || node.type === "marker_annotation"
			? node
			: mappingAnnotation(node);
	if (!ann) return null;
	const list = ann.namedChildren.find(
		(c) => c.type === "annotation_argument_list",
	);
	if (!list) return null;

	const positional = list.namedChildren.find(
		(c) => c.type === "string_literal",
	);
	if (positional) return stringText(positional);

	return argValue(ann, "value") ?? argValue(ann, "path");
}

/** value of `name = "..."` in an annotation's argument list. */
function argValue(ann: SyntaxNode, name: string): string | null {
	const list = ann.namedChildren.find(
		(c) => c.type === "annotation_argument_list",
	);
	for (const pair of list?.namedChildren ?? []) {
		if (pair.type !== "element_value_pair") continue;
		const k =
			pair.childForFieldName("key")?.text ?? pair.namedChild(0)?.text;
		if (k !== name) continue;
		const v = pair.namedChildren[pair.namedChildren.length - 1];
		if (!v) return null;
		return v.type === "string_literal" ? stringText(v) : v.text;
	}
	return null;
}

function stringText(lit: SyntaxNode): string {
	const frag = lit.namedChildren.find((c) => c.type === "string_fragment");
	return frag ? frag.text : lit.text.replace(/^["']|["']$/g, "");
}

function joinPath(a: string, b: string): string {
	const parts = `${a}/${b}`.split("/").filter(Boolean);
	return `/${parts.join("/")}`;
}
