import type { DB } from "../store/db.js";
import type { EdgeRow } from "../store/persist.js";
import type { EndpointCall } from "../lang/types.js";
import { normalizePath } from "../lang/typescript/endpoint-calls.js";

/**
 * Cross-language: link client HTTP calls (from any analyzer) to the route nodes
 * they hit, by matching normalized method + path. Runs after every route node
 * is persisted. Emits `CALLS` edges (client owner -> route node), always
 * `heuristic` since path matching is fuzzy - `query path` then traverses
 * clientFn -> route -> HANDLES -> controller -> service.
 */
export function crossLink(db: DB, calls: EndpointCall[]): EdgeRow[] {
	if (calls.length === 0) return [];

	const routes = db
		.prepare(`SELECT id, name FROM nodes WHERE kind = 'route'`)
		.all() as { id: string; name: string }[];

	// key: "GET /api/users/*" ; also index an ANY-method fallback per path
	const byKey = new Map<string, string>();
	const byPath = new Map<string, string>();
	for (const r of routes) {
		const sp = r.name.indexOf(" ");
		if (sp < 0) continue;
		const method = r.name.slice(0, sp).toUpperCase();
		const path = normalizePath(r.name.slice(sp + 1));
		byKey.set(`${method} ${path}`, r.id);
		byPath.set(path, r.id);
	}

	const nodeExists = db.prepare(`SELECT 1 FROM nodes WHERE id = ?`);
	const seen = new Set<string>();
	const edges: EdgeRow[] = [];

	for (const c of calls) {
		const path = normalizePath(c.path);
		const routeId =
			byKey.get(`${c.method.toUpperCase()} ${path}`) ??
			byKey.get(`ANY ${path}`) ??
			byPath.get(path);
		if (!routeId) continue;
		if (!nodeExists.get(c.ownerId)) continue;

		const key = `${c.ownerId}|${routeId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push({
			src: c.ownerId,
			dst: routeId,
			kind: "CALLS",
			resolution: "heuristic",
			file: c.file,
			line: c.line,
		});
	}
	return edges;
}
