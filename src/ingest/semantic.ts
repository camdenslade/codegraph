import ts from "typescript";
import {
  moduleNodeId,
  toRelPath,
  type EdgeKind,
  type EdgeRow,
  type UnresolvedRow,
} from "../store/persist.js";
import type { ProgramBundle } from "./program.js";
import type { SymbolIndex } from "./symbol-index.js";

export interface SemanticResult {
  edges: EdgeRow[];
  unresolved: UnresolvedRow[];
}

export function semanticPass(
  bundle: ProgramBundle,
  idx: SymbolIndex,
  repoRoot: string,
  /** callable name -> candidate node ids, for the heuristic fallback */
  nameIndex: Map<string, string[]>,
): SemanticResult {
  const { checker, sourceFiles } = bundle;
  const edges: EdgeRow[] = [];
  const unresolved: UnresolvedRow[] = [];
  const seen = new Set<string>();

  function addEdge(
    src: string,
    dst: string,
    kind: EdgeKind,
    resolution: "resolved" | "heuristic",
    file: string,
    line: number,
  ): void {
    if (src === dst) return;
    const key = `${src}|${dst}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ src, dst, kind, resolution, file, line });
  }

  /** Follow alias (import) symbols to the real declaration. */
  function declFromSymbol(sym: ts.Symbol | undefined): ts.Declaration | null {
    if (!sym) return null;
    let s = sym;
    if (s.flags & ts.SymbolFlags.Alias) {
      try {
        s = checker.getAliasedSymbol(s);
      } catch {
        /* not aliased after all */
      }
    }
    return s.declarations?.[0] ?? null;
  }

  for (const sf of sourceFiles) {
    const rel = toRelPath(repoRoot, sf.fileName);
    const modId = moduleNodeId(rel);
    const ownerStack: string[] = [modId];
    const owner = (): string => ownerStack[ownerStack.length - 1]!;
    const lineOf = (n: ts.Node): number =>
      sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

    const resolveExprToId = (expr: ts.Expression): string | null => {
      const decl = declFromSymbol(checker.getSymbolAtLocation(expr));
      return decl ? idx.idForDeclaration(decl) : null;
    };

    const calleeName = (expr: ts.Expression): string | null => {
      if (ts.isIdentifier(expr)) return expr.text;
      if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
      return null;
    };

    const handleCall = (node: ts.CallExpression | ts.NewExpression): void => {
      const line = lineOf(node);
      const callee = node.expression;

      let decl: ts.Declaration | null = null;
      if (ts.isCallExpression(node)) {
        const sig = checker.getResolvedSignature(node);
        if (sig?.declaration) decl = sig.declaration as ts.Declaration;
      }
      if (!decl) {
        const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
        decl = declFromSymbol(checker.getSymbolAtLocation(nameNode));
      }

      if (decl) {
        // Resolved to something concrete.
        if (decl.getSourceFile().isDeclarationFile) return; // external library
        const targetId = idx.idForDeclaration(decl);
        if (targetId) addEdge(owner(), targetId, "CALLS", "resolved", rel, line);
        // else: in-repo but not a tracked node (local helper, nested arrow) — ignore
        return;
      }

      // No declaration at all — genuinely unresolved (any-typed, dynamic).
      const name = calleeName(callee);
      if (!name) return;
      const cands = nameIndex.get(name);
      if (cands && cands.length === 1 && cands[0] !== owner()) {
        addEdge(owner(), cands[0]!, "CALLS", "heuristic", rel, line);
      } else {
        unresolved.push({ nodeId: owner(), kind: "call", text: name, file: rel, line });
      }
    };

    const handleHeritage = (
      node: ts.ClassDeclaration | ts.InterfaceDeclaration,
    ): void => {
      if (!node.heritageClauses) return;
      const selfId = node.name ? idx.idForDeclaration(node) : null;
      if (!selfId) return;
      for (const hc of node.heritageClauses) {
        const kind: EdgeKind =
          hc.token === ts.SyntaxKind.ImplementsKeyword ? "IMPLEMENTS" : "EXTENDS";
        for (const t of hc.types) {
          const line = lineOf(t);
          const tid = resolveExprToId(t.expression);
          if (tid) addEdge(selfId, tid, kind, "resolved", rel, line);
          else
            unresolved.push({
              nodeId: selfId,
              kind: "heritage",
              text: t.expression.getText(sf),
              file: rel,
              line,
            });
        }
      }
    };

    const handleReference = (id: ts.Identifier): void => {
      const p = id.parent;
      if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === id) return;
      if (ts.isPropertyAccessExpression(p) && p.name === id) return;
      if (
        ts.isImportSpecifier(p) ||
        ts.isExportSpecifier(p) ||
        ts.isImportClause(p) ||
        ts.isNamespaceImport(p)
      )
        return;
      if (isDeclarationName(id)) return;
      if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p)) return; // type position
      if (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent)) {
        return; // already captured as EXTENDS / IMPLEMENTS
      }

      const decl = declFromSymbol(checker.getSymbolAtLocation(id));
      const targetId = decl ? idx.idForDeclaration(decl) : null;
      if (targetId) addEdge(owner(), targetId, "REFERENCES", "resolved", rel, lineOf(id));
    };

    const visit = (node: ts.Node): void => {
      const pushed = ownerIdFor(node, idx);
      if (pushed) ownerStack.push(pushed);

      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
        handleHeritage(node);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        handleCall(node);
      } else if (ts.isIdentifier(node)) {
        handleReference(node);
      }

      ts.forEachChild(node, visit);
      if (pushed) ownerStack.pop();
    };

    ts.forEachChild(sf, visit);
  }

  return { edges, unresolved };
}

/** If entering this node changes the "current owner", return the new owner id. */
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

function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent as ts.Node & { name?: ts.Node };
  return (
    "name" in p &&
    p.name === id &&
    (ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isBindingElement(p))
  );
}
