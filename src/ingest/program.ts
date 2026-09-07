import ts from "typescript";

export interface ProgramBundle {
	program: ts.Program;
	checker: ts.TypeChecker;
	/** The repo's own source files only. */
	sourceFiles: ts.SourceFile[];
}

const norm =
	process.platform === "win32"
		? (p: string) => p.replace(/\\/g, "/").toLowerCase()
		: (p: string) => p.replace(/\\/g, "/");

/** One Program over the whole repo, expensive since we build it once but then we share the checker */
export function createProgram(
	rootFiles: string[], // absolute paths
	options: ts.CompilerOptions,
): ProgramBundle {
	const program = ts.createProgram({
		rootNames: rootFiles,
		options: { ...options, noEmit: true, skipLibCheck: true },
	});
	const checker = program.getTypeChecker();

	const rootSet = new Set(rootFiles.map(norm));
	const sourceFiles = program
		.getSourceFiles()
		.filter(
			(sf) => !sf.isDeclarationFile && rootSet.has(norm(sf.fileName)),
		);

	return { program, checker, sourceFiles };
}
