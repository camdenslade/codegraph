import { extname } from "node:path";
import type { LanguageAnalyzer } from "./types.js";
import { javaAnalyzer } from "./java/index.js";
import { typeScriptAnalyzer } from "./typescript/index.js";

/** Every language analyzer, in priority order. */
export const ANALYZERS: LanguageAnalyzer[] = [typeScriptAnalyzer, javaAnalyzer];

export function analyzerForFile(file: string): LanguageAnalyzer | undefined {
	const ext = extname(file).toLowerCase();
	return ANALYZERS.find((a) => a.extensions.includes(ext));
}
