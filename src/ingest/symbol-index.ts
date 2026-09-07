import ts from "typescript";
import { nodeId, toRelPath } from "../store/persist.js";

export interface SymbolIndex {
    /** Node id for a TS declaration, or null if it's not a symbol that we track */
    idForDeclaration(decl: ts.Declaration): string | null;
    has(id: string): boolean;
}

const norm = process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;

export function createSymbolIndex(
    repoRoot: string,
    ids: Iterable<string>, // every node id currently in the graph
): SymbolIndex {
    const canonical = new Map<string, string>();
    for (const id of ids) canonical.set(norm(id), id);

    function idForDeclaration(decl: ts.Declaration): string | null {
        const sf = decl.getSourceFile();
        if (sf.isDeclarationFile) return null;

        const c = classify(decl);
        if (!c) return null;

        const rel = toRelPath(repoRoot, sf.fileName);
        const qn = c.container ? `${rel}:${c.container}.${c.name}` : `${rel}:${c.name}`;
        return canonical.get(norm(nodeId(c.kind, qn))) ?? null;
    }

    return { idForDeclaration, has: (id) => canonical.has(norm(id)) };
}

/** Map a TS declaration node to our (kind, name, container). */
function classify(decl: ts.Node): { kind: string; name: string; container?: string } | null {
    if (ts.isFunctionDeclaration(decl) && decl.name) {
        return { kind: "function", name: decl.name.text };
    }
    if (ts.isClassDeclaration(decl) && decl.name) {
        return { kind: "class", name: decl.name.text };
    }
    if (ts.isInterfaceDeclaration(decl)) {
        return { kind: "interface", name: decl.name.text };
    }
    if (ts.isTypeAliasDeclaration(decl)) {
        return { kind: "type-alias", name: decl.name.text };
    }
    if (ts.isEnumDeclaration(decl)) {
        return { kind: "enum", name: decl.name.text };
    }
    if (
        ts.isMethodDeclaration(decl) &&
        decl.name &&
        ts.isIdentifier(decl.name) &&
        ts.isClassLike(decl.parent) &&
        decl.parent.name
    ) {
        return {
            kind: "method",
            name: decl.name.text,
            container: decl.parent.name.text,
        };
    }
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
        return { kind: "variable", name: decl.name.text };
    }
    return null;
}