import { extname } from "node:path";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

export type SyntaxNode = Parser.SyntaxNode;

const parser = new Parser();

/** Parse a .ts/.tsx source string into a tree-sitter tree. */
export function parseFile(file: string, source: string): Parser.Tree {
    const lang = extname(file) === ".tsx" ? TypeScript.tsx : TypeScript.typescript;
    parser.setLanguage(lang as never);
    return parser.parse(source);
}