import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDB } from "../store/db.js";
import { LineResolver } from "./lines.js";

export interface SymbolCandidate {
	id: string;
	kind: string;
	name: string;
	qualifiedName: string;
	file: string;
	line: number;
	signature: string | null;
	score: number;
}

interface Row {
	id: string;
	kind: string;
	name: string;
	qualified_name: string;
	file: string;
	span_start: number;
	signature: string | null;
}

/** Accepts a bare name, `path/to/file.ts:name`, a qualified name, or a full node id. */
export function findSymbol(
	repoRoot: string,
	query: string,
	limit = 15,
): SymbolCandidate[] {
	const db = openDB(repoRoot);
	try {
		const { filePart, namePart } = splitQuery(query);
		const fileClause = filePart
			? "AND file LIKE @fileLike COLLATE NOCASE"
			: "";

		let pool = db
			.prepare(
				`SELECT id, kind, name, qualified_name, file, span_start, signature
         FROM nodes
         WHERE (id = @q OR qualified_name = @q OR name = @q
                OR name LIKE @like COLLATE NOCASE)
           ${fileClause}`,
			)
			.all({
				q: query,
				like: `%${namePart}%`,
				fileLike: `%${filePart}%`,
			}) as Row[];

		// Fallback: subsequence match (e.g. "gsn" -> "getSymbolNeighborhood").
		if (pool.length === 0) {
			const all = db
				.prepare(
					`SELECT id, kind, name, qualified_name, file, span_start, signature
           FROM nodes ${fileClause ? `WHERE ${fileClause.replace(/^AND /, "")}` : ""}`,
				)
				.all({ fileLike: `%${filePart}%` }) as Row[];
			const needle = namePart.toLowerCase();
			pool = all.filter((r) =>
				isSubsequence(needle, r.name.toLowerCase()),
			);
		}

		const lines = new LineResolver(repoRoot);
		return pool
			.map((r) => ({
				id: r.id,
				kind: r.kind,
				name: r.name,
				qualifiedName: r.qualified_name,
				file: r.file,
				signature: r.signature,
				line: lines.lineAt(r.file, r.span_start),
				score: scoreOf(query, namePart, r),
			}))
			.sort(
				(a, b) =>
					b.score - a.score ||
					a.qualifiedName.localeCompare(b.qualifiedName),
			)
			.slice(0, limit);
	} finally {
		db.close();
	}
}

function splitQuery(q: string): { filePart: string; namePart: string } {
	const parts = q.split(":");
	if (parts.length === 2 && /[./]/.test(parts[0]!)) {
		return { filePart: parts[0]!, namePart: parts[1]! };
	}
	return { filePart: "", namePart: parts[parts.length - 1]! };
}

function scoreOf(rawQuery: string, namePart: string, r: Row): number {
	if (r.id === rawQuery) return 100;
	if (r.qualified_name === rawQuery) return 95;
	const n = r.name.toLowerCase();
	const q = namePart.toLowerCase();
	if (n === q) return 85;
	if (n.startsWith(q)) return 70;
	if (n.includes(q)) return 55;
	return 30; // subsequence-only
}

function isSubsequence(needle: string, hay: string): boolean {
	if (!needle) return false;
	let i = 0;
	for (const ch of hay) {
		if (ch === needle[i]) i++;
		if (i === needle.length) return true;
	}
	return false;
}

/** Byte offset -> 1-based line. Caches line-start offsets per file. */
function offsetToLine(
	repoRoot: string,
	file: string,
	offset: number,
	cache: Map<string, number[]>,
): number {
	let starts = cache.get(file);
	if (!starts) {
		starts = [0];
		try {
			const text = readFileSync(join(repoRoot, file), "utf8");
			for (let i = 0; i < text.length; i++) {
				if (text[i] === "\n") starts.push(i + 1);
			}
		} catch {
			/* file gone; treat as one line */
		}
		cache.set(file, starts);
	}
	let lo = 0;
	let hi = starts.length - 1;
	let ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (starts[mid]! <= offset) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans + 1;
}
