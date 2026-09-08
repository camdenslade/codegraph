import { extname } from "node:path";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

export type SyntaxNode = Parser.SyntaxNode;

const parser = new Parser();

// tree-sitter reads the source through a fixed buffer and throws "Invalid
// argument" if a file is bigger than it. Size the buffer to the file.
function bufferSize(source: string): number {
	return Buffer.byteLength(source, "utf8") + 1024;
}

/** Parse a .ts/.tsx source string into a tree-sitter tree. */
export function parseFile(file: string, source: string): Parser.Tree {
	const lang =
		extname(file) === ".tsx" ? TypeScript.tsx : TypeScript.typescript;
	parser.setLanguage(lang as never);
	return parser.parse(source, undefined, { bufferSize: bufferSize(source) });
}
