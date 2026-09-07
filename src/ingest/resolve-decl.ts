import ts from "typescript";

/** Follow alias (import/re-export) symbols to the real declaration node. */
export function declFromSymbol(
	checker: ts.TypeChecker,
	sym: ts.Symbol | undefined,
): ts.Declaration | null {
	if (!sym) return null;
	let s = sym;
	if (s.flags & ts.SymbolFlags.Alias) {
		try {
			s = checker.getAliasedSymbol(s);
		} catch {
			/* not actually aliased */
		}
	}
	return s.declarations?.[0] ?? null;
}
