import { parseFile, type SyntaxNode } from "./ts-parser.js";

export interface ImportRef {
  specifier: string; // "./foo", "@app/bar", "react", "node:fs"
  kind: "import" | "export-from";
  names: string[]; // bound local names; [] for `import "x"` and `export * from "x"`
  isTypeOnly: boolean; // `import type ...` / `export type ... from ...`
  line: number; // 1-based
}

/** Every `import ... from` and `export ... from` in one file */
export function extractImports(file: string, source: string): ImportRef[] {
    const tree = parseFile(file, source);
    const out: ImportRef[] = [];
    for (const node of tree.rootNode.namedChildren) {
        if (node.type === "import_statement") {
            const ref = fromImport(node);
            if (ref) out.push(ref);
        } else if (node.type === "export_statement") {
            const ref = fromExportFrom(node);
            if (ref) out.push(ref);
        }
    }
    return out;
}

function fromImport(node: SyntaxNode): ImportRef | null {
    const specifier = moduleSpecifier(node);
    if (!specifier) return null;
    const names: string[] = [];

    const clause = node.namedChildren.find((c) => c.type === "import_clause");
    if (clause) {
        for (const c of clause.namedChildren) {
            if (c.type === "identifier") {
                names.push(c.text); // default import
            } else if (c.type === "namespace_import") {
                const id = c.namedChildren.find((x) => x.type === "identifier");
                if (id) names.push(id.text); // * as ns
            } else if (c.type === "named_imports") {
                for (const spec of c.namedChildren) {
                    if (spec.type !== "import_specifier") continue;
                    const bound = spec.childForFieldName("alias") ?? spec.childForFieldName("name");
                    if (bound) names.push(bound.text);
                }
            }
        }
    }

    return {
        specifier,
        kind: "import",
        names,
        isTypeOnly: hasTypeKeyword(node),
        line: node.startPosition.row + 1,
    };
}

function fromExportFrom(node: SyntaxNode): ImportRef | null {
    const specifier = moduleSpecifier(node);
    if (!specifier) return null; // plain `export { x }` - no re-export, ignore here
    const names: string[] = [];

    const clause = node.namedChildren.find((c) => c.type === "export_clause");
    if (clause) {
        for (const spec of clause.namedChildren) {
            if (spec.type !== "export_specifier") continue;
            const nm = spec.childForFieldName("name");
            if (nm) names.push(nm.text);
        }
    }
    // `export * from "x" leaves names empty

    return {
        specifier,
        kind: "export-from",
        names,
        isTypeOnly: hasTypeKeyword(node),
        line: node.startPosition.row + 1,
    };
}

/** The module string, tolerant of whether the grammar exposes it as a field */
function moduleSpecifier(node: SyntaxNode): string | null {
    const field = node.childForFieldName("source");
    const str = field ?? node.namedChildren.find((c) => c.type === "string");
    return str ? str.text.replace(/^['"`]|['"`]$/g, ""): null;
}

function hasTypeKeyword(node: SyntaxNode): boolean {
    return node.children.some((c) => c.type === "type");
}