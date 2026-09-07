import { parseFile, type SyntaxNode } from "./ts-parser.js"

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type-alias"
  | "enum"
  | "variable";

export interface RawSymbol {
  kind: SymbolKind;
  name: string;
  container?: string; // enclosing class or namespace
  spanStart: number; // byte offset
  spanEnd: number;
  line: number; // 1-based
  signature: string; // no body
  doc?: string; // leading /** */ comment
  exported: boolean;
}

export interface StructuralResult {
  file: string;
  symbols: RawSymbol[];
}

/** Parse one file's text into a flat list of declared symbols. */
export function structuralParse(file: string, source: string): StructuralResult {
  const tree = parseFile(file, source);;
  const symbols: RawSymbol[] = [];
  for (const child of tree.rootNode.namedChildren) {
    visitTopLevel(child, source, symbols);
  }
  return { file, symbols };
}

function visitTopLevel(node: SyntaxNode, source: string, out: RawSymbol[]): void {
  if (node.type === "export_statement") {
    const decl = node.childForFieldName("declaration");
    if (decl) handleDeclaration(decl, source, out, true, node);
    return;
  }
  handleDeclaration(node, source, out, false, node);
}

function handleDeclaration(
  node: SyntaxNode,
  source: string,
  out: RawSymbol[],
  exported: boolean,
  docHost: SyntaxNode,
): void {
  const nameNode = node.childForFieldName("name");

  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      if (!nameNode) return;
      out.push(mk("function", nameNode.text, node, exported, docHost, source));
      return;
    }
    case "class_declaration": {
      if (!nameNode) return;
      out.push(mk("class", nameNode.text, node, exported, docHost, source));
      collectMethods(node, nameNode.text, source, out);
      return;
    }
    case "interface_declaration": {
      if (!nameNode) return;
      out.push(mk("interface", nameNode.text, node, exported, docHost, source));
      return;
    }
    case "type_alias_declaration": {
      if (!nameNode) return;
      out.push(mk("type-alias", nameNode.text, node, exported, docHost, source));
      return;
    }
    case "enum_declaration": {
      if (!nameNode) return;
      out.push(mk("enum", nameNode.text, node, exported, docHost, source));
      return;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      // FR-ING-3: top-level variables, exported only.
      if (!exported) return;
      for (const d of node.namedChildren) {
        if (d.type !== "variable_declarator") continue;
        const n = d.childForFieldName("name");
        if (!n) continue;
        out.push(mk("variable", n.text, d, true, docHost, source));
      }
      return;
    }
    default:
      return;
  }
}

function collectMethods(
  classNode: SyntaxNode,
  className: string,
  source: string,
  out: RawSymbol[],
): void {
  const body = classNode.childForFieldName("body");
  if (!body) return;
  for (const m of body.namedChildren) {
    if (m.type !== "method_definition") continue;
    const n = m.childForFieldName("name");
    if (!n) continue;
    const sym = mk("method", n.text, m, false, m, source);
    sym.container = className;
    out.push(sym);
  }
}

/** Build a RawSymbol; signature is the source up to the body, whitespace-collapsed. */
function mk(
  kind: SymbolKind,
  name: string,
  node: SyntaxNode,
  exported: boolean,
  docHost: SyntaxNode,
  source: string,
): RawSymbol {
  const body = node.childForFieldName("body");
  const sigEnd = body ? body.startIndex : node.endIndex;
  const signature = source
    .slice(node.startIndex, sigEnd)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  return {
    kind,
    name,
    spanStart: node.startIndex,
    spanEnd: node.endIndex,
    line: node.startPosition.row + 1,
    signature,
    doc: docFor(docHost),
    exported,
  };
}

function docFor(node: SyntaxNode): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev?.type === "comment" && prev.text.startsWith("/**")) return prev.text;
  return undefined;
}
