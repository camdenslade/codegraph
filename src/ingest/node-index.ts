import type { DB } from "../store/db.js";
import type { NodeIndex } from "../lang/types.js";

/** Build the cross-file lookup analyzers use during edge resolution. */
export function buildNodeIndex(db: DB): NodeIndex {
	const rows = db
		.prepare(`SELECT id, name, kind, qualified_name FROM nodes`)
		.all() as {
		id: string;
		name: string;
		kind: string;
		qualified_name: string;
	}[];

	const ids: string[] = [];
	const idSet = new Set<string>();
	const idsByName = new Map<string, string[]>();
	const typeIdsByName = new Map<string, string[]>();
	const idByQualifiedName = new Map<string, string>();

	const push = (m: Map<string, string[]>, k: string, v: string) => {
		const arr = m.get(k) ?? [];
		arr.push(v);
		m.set(k, arr);
	};

	for (const r of rows) {
		ids.push(r.id);
		idSet.add(r.id);
		idByQualifiedName.set(r.qualified_name, r.id);
		if (r.kind === "function" || r.kind === "method") {
			push(idsByName, r.name, r.id);
		} else if (
			r.kind === "class" ||
			r.kind === "interface" ||
			r.kind === "enum" ||
			r.kind === "record"
		) {
			push(typeIdsByName, r.name, r.id);
		}
	}

	return {
		ids,
		has: (id) => idSet.has(id),
		idsByName,
		typeIdsByName,
		idByQualifiedName,
	};
}
