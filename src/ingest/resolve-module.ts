import ts from "typescript";
import { toRelPath } from "../store/persist.js";

export interface ModuleResolver {
    /** Repo-relative path of an ingested file, or null if external/unresolved */
    resolve(specifier: string, fromFileAbs: string): string | null;
}

export function createModuleResolver(
    compilerOptions: ts.CompilerOptions,
    repoRoot: string,
    ingested: Iterable<string>, // repo-relative paths already in the graph
): ModuleResolver {
    const host = ts.createCompilerHost(compilerOptions);
    const cache = ts.createModuleResolutionCache(
        repoRoot,
        (f) => f,
        compilerOptions,
    );

    /** Windows fs is case-insensitive; match on a normalized key but return the
     * exact stored spelling so edge endpoints line up with the node ids. */
    const norm =
        process.platform === "win32"
            ? (s: string) => s.toLowerCase()
            : (s: string) => s;
    const canonical = new Map<string, string>();
    for (const p of ingested) canonical.set(norm(p), p);

    return {
        resolve(specifier, fromFileAbs) {
            const { resolvedModule } = ts.resolveModuleName(
                specifier,
                fromFileAbs,
                compilerOptions,
                host,
                cache,
            );
            if (!resolvedModule) return null;
            if (resolvedModule.isExternalLibraryImport) return null; // node_modules
            if (resolvedModule.resolvedFileName.endsWith(".d.ts")) return null;

            const rel = toRelPath(repoRoot, resolvedModule.resolvedFileName);
            return canonical.get(norm(rel)) ?? null;
        },
    };
}