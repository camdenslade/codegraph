import type Parser from "tree-sitter";
import type { EdgeRow, UnresolvedRow } from "../../store/persist.js";

type SyntaxNode = Parser.SyntaxNode;

export interface TypeRef {
	rel: string;
	name: string;
}

export interface JavaCallCtx {
	relPath: string;
	/** class name -> the method names it declares in THIS file */
	classMethods: Map<string, Set<string>>;
	/** class name -> its resolved superclass, for `super.x()` and inherited bare calls */
	parentOf(className: string): TypeRef | null;
	/** simple type name -> the in-repo type it refers to from this file, or null */
	resolveTypeRef(simple: string): TypeRef | null;
	has(id: string): boolean;
	/** method name -> node ids across the whole graph, for the bare-call heuristic */
	methodIdsByName: Map<string, string[]>;
}

interface Frame {
	className?: string;
	ownerId?: string;
	vars: Map<string, string>; // var name -> simple type name
}

/**
 * Syntactic Java call resolution: same-class calls, `this.field.m()` /
 * `field.m()` via the field's declared type, `localVar.m()` via the local's
 * declared type, `Type.staticM()`, `super.m()`, and `new Type()`. No return-type
 * inference, so chained calls (`a.b().c()`) and stream/lambda pipelines are left
 * unresolved. Constructor-injected Spring beans resolve because the field type
 * is right there in the declaration.
 */
export function extractCalls(
	root: SyntaxNode,
	ctx: JavaCallCtx,
): { edges: EdgeRow[]; unresolved: UnresolvedRow[] } {
	const edges: EdgeRow[] = [];
	const unresolved: UnresolvedRow[] = [];
	const seen = new Set<string>();

	const stack: Frame[] = [{ vars: new Map() }];
	const topWith = <K extends keyof Frame>(k: K): Frame[K] | undefined => {
		for (let i = stack.length - 1; i >= 0; i--) {
			if (stack[i]![k] !== undefined) return stack[i]![k];
		}
		return undefined;
	};
	const className = () => topWith("className") as string | undefined;
	const ownerId = () => topWith("ownerId") as string | undefined;
	const lookupVar = (n: string): string | undefined => {
		for (let i = stack.length - 1; i >= 0; i--) {
			const t = stack[i]!.vars.get(n);
			if (t) return t;
		}
		return undefined;
	};

	const addEdge = (
		src: string,
		dst: string,
		resolution: "resolved" | "heuristic",
		line: number,
	): void => {
		if (src === dst) return;
		const key = `${src}|${dst}`;
		if (seen.has(key)) return;
		seen.add(key);
		edges.push({
			src,
			dst,
			kind: "CALLS",
			resolution,
			file: ctx.relPath,
			line,
		});
	};

	const mid = (t: TypeRef, method: string) =>
		`method:${t.rel}:${t.name}.${method}`;

	const resolveTarget = (
		obj: SyntaxNode | null,
		method: string,
	): { id: string; heuristic?: boolean } | null => {
		if (!obj) {
			const cn = className();
			if (cn && ctx.classMethods.get(cn)?.has(method)) {
				return { id: mid({ rel: ctx.relPath, name: cn }, method) };
			}
			if (cn) {
				const parent = ctx.parentOf(cn);
				if (parent) {
					const id = mid(parent, method);
					if (ctx.has(id)) return { id };
				}
			}
			const cands = ctx.methodIdsByName.get(method);
			if (cands && cands.length === 1)
				return { id: cands[0]!, heuristic: true };
			return null;
		}
		if (obj.type === "this") {
			const cn = className();
			return cn
				? { id: mid({ rel: ctx.relPath, name: cn }, method) }
				: null;
		}
		if (obj.type === "super") {
			const cn = className();
			const parent = cn ? ctx.parentOf(cn) : null;
			return parent ? { id: mid(parent, method) } : null;
		}
		if (obj.type === "identifier") {
			const t = lookupVar(obj.text);
			if (t) {
				const ref = ctx.resolveTypeRef(t);
				return ref ? { id: mid(ref, method) } : null;
			}
			if (/^[A-Z]/.test(obj.text)) {
				const ref = ctx.resolveTypeRef(obj.text); // Type.staticMethod()
				if (ref) return { id: mid(ref, method) };
			}
			return null;
		}
		if (obj.type === "field_access") {
			const fld =
				obj.childForFieldName("field")?.text ?? lastIdentifier(obj);
			const t = fld ? lookupVar(fld) : undefined;
			if (t) {
				const ref = ctx.resolveTypeRef(t);
				return ref ? { id: mid(ref, method) } : null;
			}
			return null;
		}
		return null; // chained call, cast, array access, etc.
	};

	const handleInvocation = (node: SyntaxNode): void => {
		const method = node.childForFieldName("name")?.text;
		if (!method) return;
		const src = ownerId();
		// owner may be a class-init frame whose id we couldn't reconstruct
		// (nested class / enum); skip rather than write a dangling row.
		if (!src || !ctx.has(src)) return;
		const obj = node.childForFieldName("object");
		const line = node.startPosition.row + 1;

		const target = resolveTarget(obj, method);
		if (target && ctx.has(target.id)) {
			addEdge(
				src,
				target.id,
				target.heuristic ? "heuristic" : "resolved",
				line,
			);
		} else {
			unresolved.push({
				nodeId: src,
				kind: "call",
				text: `${obj ? `${obj.text.slice(0, 40)}.` : ""}${method}`,
				file: ctx.relPath,
				line,
			});
		}
	};

	const handleNew = (node: SyntaxNode): void => {
		const t = simpleType(node.childForFieldName("type"));
		const src = ownerId();
		if (!t || !src || !ctx.has(src)) return;
		const line = node.startPosition.row + 1;
		const ref = ctx.resolveTypeRef(t);
		if (ref) {
			const initId = `method:${ref.rel}:${ref.name}.<init>`;
			const classId = `class:${ref.rel}:${ref.name}`;
			if (ctx.has(initId)) return addEdge(src, initId, "resolved", line);
			if (ctx.has(classId))
				return addEdge(src, classId, "resolved", line);
		}
		unresolved.push({
			nodeId: src,
			kind: "call",
			text: `new ${t}`,
			file: ctx.relPath,
			line,
		});
	};

	const visit = (node: SyntaxNode): void => {
		let pushed = false;

		if (
			node.type === "class_declaration" ||
			node.type === "interface_declaration" ||
			node.type === "enum_declaration"
		) {
			const cn = nameOf(node);
			const frame: Frame = {
				className: cn,
				ownerId: cn ? `class:${ctx.relPath}:${cn}` : undefined,
				vars: new Map(),
			};
			const body = node.namedChildren.find((c) =>
				c.type.endsWith("_body"),
			);
			if (body) {
				for (const m of body.namedChildren) {
					if (m.type === "field_declaration")
						addFieldVars(m, frame.vars);
				}
			}
			stack.push(frame);
			pushed = true;
		} else if (
			node.type === "method_declaration" ||
			node.type === "constructor_declaration"
		) {
			const cn = className();
			const mn =
				node.type === "constructor_declaration"
					? "<init>"
					: nameOf(node);
			const frame: Frame = {
				ownerId:
					cn && mn ? `method:${ctx.relPath}:${cn}.${mn}` : ownerId(),
				vars: new Map(),
			};
			const fp = node.namedChildren.find(
				(c) => c.type === "formal_parameters",
			);
			if (fp) {
				for (const p of fp.namedChildren) {
					if (p.type !== "formal_parameter") continue;
					const nm = p.childForFieldName("name")?.text;
					const ty = simpleType(p.childForFieldName("type"));
					if (nm && ty) frame.vars.set(nm, ty);
				}
			}
			const blk = node.namedChildren.find((c) => c.type === "block");
			if (blk) collectLocals(blk, frame.vars);
			stack.push(frame);
			pushed = true;
		}

		if (node.type === "method_invocation") handleInvocation(node);
		else if (node.type === "object_creation_expression") handleNew(node);

		for (const c of node.namedChildren) visit(c);
		if (pushed) stack.pop();
	};

	visit(root);
	return { edges, unresolved };
}

function nameOf(node: SyntaxNode): string | undefined {
	return (
		node.childForFieldName("name")?.text ??
		node.namedChildren.find((c) => c.type === "identifier")?.text
	);
}

function lastIdentifier(node: SyntaxNode): string | undefined {
	let found: string | undefined;
	const walk = (n: SyntaxNode) => {
		if (n.type === "identifier") found = n.text;
		for (const c of n.namedChildren) walk(c);
	};
	walk(node);
	return found;
}

/** A type node -> its simple name, or null for primitives / unresolvable shapes. */
function simpleType(node: SyntaxNode | null): string | null {
	if (!node) return null;
	switch (node.type) {
		case "type_identifier":
			return node.text;
		case "scoped_type_identifier":
			return node.text.split(".").pop() ?? node.text;
		case "generic_type": {
			const base = node.namedChildren.find(
				(c) =>
					c.type === "type_identifier" ||
					c.type === "scoped_type_identifier",
			);
			return base ? (base.text.split(".").pop() ?? base.text) : null;
		}
		default:
			return null; // integral_type, boolean_type, array_type, void_type, ...
	}
}

function addFieldVars(field: SyntaxNode, vars: Map<string, string>): void {
	const ty = simpleType(field.childForFieldName("type"));
	if (!ty) return;
	for (const d of field.namedChildren) {
		if (d.type !== "variable_declarator") continue;
		const nm = d.childForFieldName("name")?.text;
		if (nm) vars.set(nm, ty);
	}
}

function collectLocals(block: SyntaxNode, vars: Map<string, string>): void {
	const walk = (n: SyntaxNode) => {
		if (n.type === "local_variable_declaration") {
			const ty = simpleType(n.childForFieldName("type"));
			if (ty) {
				for (const d of n.namedChildren) {
					if (d.type !== "variable_declarator") continue;
					const nm = d.childForFieldName("name")?.text;
					if (nm) vars.set(nm, ty);
				}
			}
		}
		for (const c of n.namedChildren) walk(c);
	};
	walk(block);
}
