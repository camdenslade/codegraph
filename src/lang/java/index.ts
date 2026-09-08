import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import Parser from "tree-sitter";
import Java from "tree-sitter-java";
import { moduleNodeId, type EdgeRow } from "../../store/persist.js";
import type {
	Discovered,
	LangImport,
	LangSymbol,
	LanguageAnalyzer,
	ParsedUnit,
	ResolveInput,
	ResolveOutput,
	SymbolKind,
} from "../types.js";
import { extractCalls, type TypeRef } from "./calls.js";
import { extractSpringRoutes } from "./routes.js";

type SyntaxNode = Parser.SyntaxNode;

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"target",
	"build",
	"out",
	"bin",
	".gradle",
	".idea",
	"dist",
	".next",
]);

const TYPE_KINDS: Record<string, SymbolKind> = {
	class_declaration: "class",
	interface_declaration: "interface",
	enum_declaration: "enum",
	record_declaration: "record",
};

interface JavaUnitMeta {
	pkg: string;
	tree: Parser.Tree;
}

const parser = new Parser();

export const javaAnalyzer: LanguageAnalyzer = {
	id: "java",
	extensions: [".java"],

	discoverFiles(repoRoot: string): Discovered {
		const root = resolve(repoRoot);
		const ig = ignore();
		const gi = join(root, ".gitignore");
		if (existsSync(gi)) ig.add(readFileSync(gi, "utf8"));

		const files: string[] = [];
		const walk = (dir: string): void => {
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				const full = join(dir, ent.name);
				const rel = relative(root, full).split(sep).join("/");
				if (ent.isDirectory()) {
					if (SKIP_DIRS.has(ent.name)) continue;
					if (rel && ig.ignores(`${rel}/`)) continue;
					walk(full);
				} else if (ent.isFile() && ent.name.endsWith(".java")) {
					if (!ig.ignores(rel)) files.push(full);
				}
			}
		};
		walk(root);
		files.sort();
		return { repoRoot: root, files };
	},

	parseFile(relPath, absPath, source): ParsedUnit {
		parser.setLanguage(Java as never);
		const tree = parser.parse(source, undefined, {
			bufferSize: Buffer.byteLength(source, "utf8") + 1024,
		});
		const root = tree.rootNode;

		let pkg = "";
		const symbols: LangSymbol[] = [];
		const imports: LangImport[] = [];

		for (const node of root.namedChildren) {
			if (node.type === "package_declaration") {
				pkg = node.namedChild(0)?.text ?? "";
			} else if (node.type === "import_declaration") {
				const id = node.namedChildren.find(
					(c) =>
						c.type === "scoped_identifier" ||
						c.type === "identifier",
				);
				if (!id) continue;
				const star = node.namedChildren.some(
					(c) => c.type === "asterisk",
				);
				imports.push({
					specifier: star ? `${id.text}.*` : id.text,
					kind: "import",
					names: star ? [] : [id.text.split(".").pop() ?? id.text],
					isTypeOnly: false,
					line: node.startPosition.row + 1,
				});
			} else if (TYPE_KINDS[node.type]) {
				collectType(node, undefined, source, symbols);
			}
		}

		return {
			relPath,
			absPath,
			symbols,
			imports,
			meta: { pkg, tree } satisfies JavaUnitMeta,
		};
	},

	resolveEdges(input: ResolveInput): ResolveOutput {
		const { units, allRelPaths, index } = input;
		const edges: EdgeRow[] = [];
		const unresolved: ResolveOutput["unresolved"] = [];
		const routeNodes: ResolveOutput["routeNodes"] = [];

		const resolveFqnToRel = (fqn: string): string | null => {
			const suffix = `${fqn.replace(/\./g, "/")}.java`;
			return (
				allRelPaths.find(
					(r) => r === suffix || r.endsWith(`/${suffix}`),
				) ?? null
			);
		};
		// id form is `kind:rel:name`, so rel is everything between the first
		// and last colon.
		const relOfId = (id: string) =>
			id.slice(id.indexOf(":") + 1, id.lastIndexOf(":"));

		for (const unit of units) {
			const meta = unit.meta as JavaUnitMeta | undefined;
			if (!meta) continue;
			const { pkg, tree } = meta;
			const root = tree.rootNode;
			const srcMod = moduleNodeId(unit.relPath);

			/** Simple type name -> the in-repo type it refers to from this file. */
			const resolveTypeRef = (
				simple: string,
			): (TypeRef & { resolution: "resolved" | "heuristic" }) | null => {
				const imp = unit.imports.find(
					(i) =>
						!i.specifier.endsWith(".*") &&
						i.specifier.endsWith(`.${simple}`),
				);
				if (imp) {
					const rel = resolveFqnToRel(imp.specifier);
					if (rel)
						return { rel, name: simple, resolution: "resolved" };
				}
				if (pkg) {
					const rel = resolveFqnToRel(`${pkg}.${simple}`);
					if (rel)
						return { rel, name: simple, resolution: "resolved" };
				}
				const byName = index.typeIdsByName.get(simple);
				if (byName && byName.length === 1) {
					return {
						rel: relOfId(byName[0]!),
						name: simple,
						resolution: "heuristic",
					};
				}
				return null;
			};

			// IMPORTS: FQN -> file (standard src/main/java layout).
			for (const imp of unit.imports) {
				const line = imp.line;
				if (imp.specifier.endsWith(".*")) {
					unresolved.push({
						nodeId: srcMod,
						kind: "import",
						text: imp.specifier,
						file: unit.relPath,
						line,
					});
					continue;
				}
				const rel = resolveFqnToRel(imp.specifier);
				if (rel && rel !== unit.relPath) {
					edges.push({
						src: srcMod,
						dst: moduleNodeId(rel),
						kind: "IMPORTS",
						resolution: "resolved",
						file: unit.relPath,
						line,
					});
				} else {
					unresolved.push({
						nodeId: srcMod,
						kind: "import",
						text: imp.specifier,
						file: unit.relPath,
						line,
					});
				}
			}

			// EXTENDS / IMPLEMENTS, and record resolved superclasses for the call pass.
			const parentByClass = new Map<string, TypeRef>();
			for (const h of extractHeritage(root)) {
				const selfId = index.idByQualifiedName.get(
					`${unit.relPath}:${h.owner}`,
				);
				if (!selfId) continue;
				const ref = resolveTypeRef(h.target);
				const dstId = ref
					? index.idByQualifiedName.get(`${ref.rel}:${ref.name}`)
					: undefined;
				if (ref && dstId) {
					edges.push({
						src: selfId,
						dst: dstId,
						kind: h.kind,
						resolution: ref.resolution,
						file: unit.relPath,
						line: h.line,
					});
					if (h.kind === "EXTENDS") {
						parentByClass.set(h.owner, {
							rel: ref.rel,
							name: ref.name,
						});
					}
				} else {
					unresolved.push({
						nodeId: selfId,
						kind: "heritage",
						text: h.target,
						file: unit.relPath,
						line: h.line,
					});
				}
			}

			// CALLS (syntactic resolution - see calls.ts).
			const classMethods = new Map<string, Set<string>>();
			for (const s of unit.symbols) {
				if (s.kind === "method" && s.container) {
					const set =
						classMethods.get(s.container) ??
						classMethods
							.set(s.container, new Set())
							.get(s.container)!;
					set.add(s.name);
				}
			}
			const calls = extractCalls(root, {
				relPath: unit.relPath,
				classMethods,
				parentOf: (cn) => parentByClass.get(cn) ?? null,
				resolveTypeRef: (s) => {
					const r = resolveTypeRef(s);
					return r ? { rel: r.rel, name: r.name } : null;
				},
				has: (id) => index.has(id),
				methodIdsByName: index.idsByName,
			});
			edges.push(...calls.edges);
			unresolved.push(...calls.unresolved);

			// Spring MVC routes.
			const routes = extractSpringRoutes(
				root,
				unit.relPath,
				(id: string) => index.has(id),
			);
			routeNodes.push(...routes.routeNodes);
			edges.push(...routes.edges);
		}

		return { edges, unresolved, routeNodes };
	},
};

// symbol extraction

function collectType(
	node: SyntaxNode,
	container: string | undefined,
	source: string,
	out: LangSymbol[],
): void {
	const kind = TYPE_KINDS[node.type];
	if (!kind) return;
	const nameNode =
		node.childForFieldName("name") ??
		node.namedChildren.find((c) => c.type === "identifier");
	if (!nameNode) return;
	const name = nameNode.text;

	out.push({
		kind,
		name,
		container,
		spanStart: node.startIndex,
		spanEnd: node.endIndex,
		line: node.startPosition.row + 1,
		signature: headingOf(node, source),
		doc: javadocOf(node),
		exported: isPublicish(node),
	});

	const body = node.namedChildren.find(
		(c) =>
			c.type === "class_body" ||
			c.type === "interface_body" ||
			c.type === "enum_body",
	);
	if (!body) return;

	for (const m of body.namedChildren) {
		if (
			m.type === "method_declaration" ||
			m.type === "constructor_declaration"
		) {
			const mn =
				m.childForFieldName("name") ??
				m.namedChildren.find((c) => c.type === "identifier");
			if (!mn) continue;
			// A constructor's name is the class name; store it as <init> so it
			// doesn't collide with the class on a bare-name lookup.
			const mName =
				m.type === "constructor_declaration" ? "<init>" : mn.text;
			out.push({
				kind: "method",
				name: mName,
				container: name,
				spanStart: m.startIndex,
				spanEnd: m.endIndex,
				line: m.startPosition.row + 1,
				signature: headingOf(m, source),
				doc: javadocOf(m),
				exported: isPublicish(m),
			});
		} else if (TYPE_KINDS[m.type]) {
			collectType(m, name, source, out); // nested type
		}
	}
}

function headingOf(node: SyntaxNode, source: string): string {
	// Type bodies are `*_body`; method / constructor bodies are `block`.
	const body = node.namedChildren.find(
		(c) => c.type.endsWith("_body") || c.type === "block",
	);
	const end = body ? body.startIndex : node.endIndex;
	return source
		.slice(node.startIndex, end)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
}

function javadocOf(node: SyntaxNode): string | undefined {
	const prev = node.previousNamedSibling;
	if (prev?.type === "block_comment" && prev.text.startsWith("/**")) {
		return prev.text;
	}
	return undefined;
}

function isPublicish(node: SyntaxNode): boolean {
	const mods = node.namedChildren.find((c) => c.type === "modifiers");
	const text = mods?.text ?? "";
	return text.includes("public") || text.includes("protected");
}

// heritage

interface HeritageRef {
	owner: string; // simple name of the declaring type
	target: string; // simple name of the extended/implemented type
	kind: "EXTENDS" | "IMPLEMENTS";
	line: number;
}

function extractHeritage(root: SyntaxNode): HeritageRef[] {
	const refs: HeritageRef[] = [];

	const visit = (node: SyntaxNode): void => {
		if (
			node.type === "class_declaration" ||
			node.type === "interface_declaration"
		) {
			const owner =
				node.childForFieldName("name")?.text ??
				node.namedChildren.find((c) => c.type === "identifier")?.text;
			if (owner) {
				for (const c of node.namedChildren) {
					if (c.type === "superclass") {
						for (const t of typeNames(c)) {
							refs.push({
								owner,
								target: t,
								kind: "EXTENDS",
								line: c.startPosition.row + 1,
							});
						}
					} else if (
						c.type === "super_interfaces" ||
						c.type === "extends_interfaces"
					) {
						const ek =
							node.type === "interface_declaration"
								? "EXTENDS"
								: "IMPLEMENTS";
						for (const t of typeNames(c)) {
							refs.push({
								owner,
								target: t,
								kind: ek,
								line: c.startPosition.row + 1,
							});
						}
					}
				}
			}
		}
		for (const c of node.namedChildren) visit(c);
	};
	visit(root);
	return refs;
}

/**
 * Simple names of the top-level supertypes in a heritage clause. Only the base
 * of each entry in the type_list - NOT the generic arguments, so
 * `JpaRepository<DuesPayment, UUID>` yields `JpaRepository`, not `DuesPayment`.
 */
function typeNames(clause: SyntaxNode): string[] {
	const list =
		clause.namedChildren.find((c) => c.type === "type_list") ?? clause;
	const out: string[] = [];
	for (const entry of list.namedChildren) {
		const base =
			entry.type === "generic_type"
				? entry.namedChildren.find(
						(c) =>
							c.type === "type_identifier" ||
							c.type === "scoped_type_identifier",
					)
				: entry.type === "type_identifier" ||
					  entry.type === "scoped_type_identifier"
					? entry
					: undefined;
		if (base) out.push(base.text.split(".").pop() ?? base.text);
	}
	return out;
}
