import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import ignore from "ignore";

export interface Discovered {
	repoRoot: string;
	tsconfigPath: string;
	options: ts.CompilerOptions;
	files: string[];
}

/** Find source files the way the repo's own tsconfig and .gitignore define them */
export function discoverFiles(repoRoot: string): Discovered {
	const root = resolve(repoRoot);
	const tsconfigPath = ts.findConfigFile(
		root,
		ts.sys.fileExists,
		"tsconfig.json",
	);
	if (!tsconfigPath) {
		throw new Error(`No tsconfig.json found in ${root}`);
	}

	// Read JSON from tsconfig.json and parse it into a config object.
	const readResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (readResult.error) {
		throw new Error(
			`Error reading tsconfig.json: ${readResult.error.messageText}`,
		);
	}

	// Expand includes/excludes and resolve file paths relative to the repo root.
	const parsed = ts.parseJsonConfigFileContent(
		readResult.config,
		ts.sys,
		resolve(tsconfigPath, ".."),
	);
	if (parsed.errors.length > 0) {
		throw new Error(
			`Error parsing tsconfig.json: ${parsed.errors.map((e) => e.messageText).join(", ")}`,
		);
	}

	const gitignore = loadGitIgnore(root);
	const files = parsed.fileNames
		.filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
		.filter((f) => !f.endsWith(".d.ts"))
		.filter((f) => !gitignore.ignores(relative(root, f)))
		.map((f) => resolve(f))
		.sort();

	return {
		repoRoot: root,
		tsconfigPath: resolve(tsconfigPath),
		options: parsed.options,
		files,
	};
}

function loadGitIgnore(root: string) {
	const ig = ignore();
	const path = join(root, ".gitignore");
	if (existsSync(path)) ig.add(readFileSync(path, "utf-8"));
	return ig;
}

function formatTsError(d: ts.Diagnostic): string {
	return ts.flattenDiagnosticMessageText(d.messageText, "\n");
}
