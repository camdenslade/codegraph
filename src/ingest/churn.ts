import { execFileSync } from "node:child_process";

export interface FileChurn {
	path: string; // repo-relative, forward slashes
	commits: number;
	lastCommit: number | null; // unix seconds
}

const MAX_COMMITS = 5000; // bound the walk on huge histories

/**
 * Per-file commit count and last-touched time from `git log`. Returns [] if the
 * repo is not a git checkout or git is unavailable - churn is optional.
 */
export function collectChurn(repoRoot: string): FileChurn[] {
	let out: string;
	try {
		out = execFileSync(
			"git",
			[
				"-C",
				repoRoot,
				"log",
				`-n${MAX_COMMITS}`,
				"--no-merges",
				"--no-renames",
				"--pretty=format:@%ct",
				"--name-only",
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				maxBuffer: 64 << 20,
			},
		);
	} catch {
		return [];
	}

	const byPath = new Map<string, { commits: number; last: number | null }>();
	let ts: number | null = null;
	for (const line of out.split("\n")) {
		if (line.startsWith("@")) {
			ts = Number(line.slice(1)) || null;
			continue;
		}
		const path = line.trim();
		if (!path) continue;
		const cur = byPath.get(path) ?? { commits: 0, last: null };
		cur.commits++;
		if (ts !== null && (cur.last === null || ts > cur.last)) cur.last = ts;
		byPath.set(path, cur);
	}

	return [...byPath].map(([path, v]) => ({
		path,
		commits: v.commits,
		lastCommit: v.last,
	}));
}
