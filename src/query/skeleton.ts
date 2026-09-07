import { openDB } from "../store/db.js";

export interface SkeletonModule {
    path: string; // repo-relative module path
    exports: string[]; // names of exported symbols, sorted
}

export interface SkeletonEdge {
    fromPath: string;
    toPath: string;
}

export interface Skeleton {
    modules: SkeletonModule[];
    imports: SkeletonEdge[];
}

/** FR-SLICE-6: module nodes + IMPORTS edges + per-module exported names, no bodies */
export function getSkeleton(repoRoot: string): Skeleton {
    const db = openDB(repoRoot);
    try {
        const modules = db
            .prepare(
                `SELECT qualified_name AS path FROM nodes
                WHERE kind = 'module' ORDER BY qualified_name`,
            )
            .all() as { path: string }[];

        const exportRows = db
            .prepare(
                `SELECT file AS modulePath, name FROM nodes
                WHERE exported = 1 AND kind != 'module'
                ORDER BY file, name`,
            )
            .all() as { modulePath: string; name: string }[];

        const importRows = db
            .prepare(
                `SELECT s.qualified_name AS fromPath, d.qualified_name AS toPath
                FROM edges e
                JOIN nodes s ON s.id = e.src
                JOIN nodes d ON d.id = e.dst
                WHERE e.kind = 'IMPORTS'
                ORDER BY fromPath, toPath`,
            )
            .all() as { fromPath: string; toPath: string }[];

        const exportsByModule = new Map<string, string[]>();
        for (const { modulePath, name } of exportRows) {
            const arr = exportsByModule.get(modulePath) ?? [];
            arr.push(name);
            exportsByModule.set(modulePath, arr);
        }

        return {
            modules: modules.map((m) => ({
                path: m.path,
                exports: exportsByModule.get(m.path) ?? [],
            })),
            imports: importRows.map((r) => ({ fromPath: r.fromPath, toPath: r.toPath })),
        };
    } finally {
        db.close();
    }
}