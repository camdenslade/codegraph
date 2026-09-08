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
		const root = parser.parse(source, undefined, {
			bufferSize: Buffer.byteLength(source, "utf8") + 1024,
		}).rootNode;

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
			meta: { pkg } satisfies JavaUnitMeta,
		};
	},

	resolveEdges(input: ResolveInput): ResolveOutput {
		const { units, allRelPaths, index } = input;
		const edges: EdgeRow[] = [];
		const unresolved: ResolveOutput["unresolved"] = [];

		const resolveFqnToRel = (fqn: string): string | null => {
			const suffix = `${fqn.replace(/\./g, "/")}.java`;
			return (
				allRelPaths.find(
					(r) => r === suffix || r.endsWith(`/${suffix}`),
				) ?? null
			);
		};

		for (const unit of units) {
			const pkg = (unit.meta as JavaUnitMeta | undefined)?.pkg ?? "";
			const srcMod = moduleNodeId(unit.relPath);

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

			// EXTENDS / IMPLEMENTS: re-parse this unit's tree for heritage.
			const heritage = extractHeritage(unit.absPath);
			for (const h of heritage) {
				const selfId = index.idByQualifiedName.get(
					`${unit.relPath}:${h.owner}`,
				);
				if (!selfId) continue;
				const resolved = resolveTypeName(
					h.target,
					pkg,
					unit.imports,
					resolveFqnToRel,
					index,
				);
				if (resolved) {
					edges.push({
						src: selfId,
						dst: resolved.id,
						kind: h.kind,
						resolution: resolved.resolution,
						file: unit.relPath,
						line: h.line,
					});
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
		}

		// Java CALLS need type resolution (JDT) - deferred to v1.1.
		return { edges, unresolved, routeNodes: [] };
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
	const body = node.namedChildren.find((c) => c.type.endsWith("_body"));
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

function extractHeritage(absPath: string): HeritageRef[] {
	let source: string;
	try {
		source = readFileSync(absPath, "utf8");
	} catch {
		return [];
	}
	parser.setLanguage(Java as never);
	const root = parser.parse(source, undefined, {
		bufferSize: Buffer.byteLength(source, "utf8") + 1024,
	}).rootNode;
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

/** Simple names of every type_identifier under a heritage clause. */
function typeNames(clause: SyntaxNode): string[] {
	const out: string[] = [];
	const walk = (n: SyntaxNode): void => {
		if (n.type === "type_identifier") out.push(n.text);
		else if (n.type === "scoped_type_identifier") {
			out.push(n.text.split(".").pop() ?? n.text);
		}
		for (const c of n.namedChildren) walk(c);
	};
	walk(clause);
	return out;
}

function resolveTypeName(
	simple: string,
	pkg: string,
	imports: LangImport[],
	resolveFqnToRel: (fqn: string) => string | null,
	index: ResolveInput["index"],
): { id: string; resolution: "resolved" | "heuristic" } | null {
	const idAt = (rel: string | null) =>
		rel ? (index.idByQualifiedName.get(`${rel}:${simple}`) ?? null) : null;

	// 1. explicit import ending in `.<simple>`
	const imp = imports.find(
		(i) =>
			!i.specifier.endsWith(".*") && i.specifier.endsWith(`.${simple}`),
	);
	const viaImport = imp && idAt(resolveFqnToRel(imp.specifier));
	if (viaImport) return { id: viaImport, resolution: "resolved" };

	// 2. same package
	const viaPkg = pkg && idAt(resolveFqnToRel(`${pkg}.${simple}`));
	if (viaPkg) return { id: viaPkg, resolution: "resolved" };

	// 3. unique name across the graph
	const byName = index.typeIdsByName.get(simple);
	if (byName && byName.length === 1) {
		return { id: byName[0]!, resolution: "heuristic" };
	}
	return null;
}
