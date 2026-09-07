import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Byte offset -> 1-based line number, caching each file's newline offsets. */
export class LineResolver {
	private cache = new Map<string, number[]>();
	constructor(private readonly repoRoot: string) {}

	lineAt(file: string, offset: number): number {
		let starts = this.cache.get(file);
		if (!starts) {
			starts = [0];
			try {
				const text = readFileSync(join(this.repoRoot, file), "utf-8");
				for (let i = 0; i < text.length; i++) {
					if (text[i] === "\n") starts.push(i + 1);
				}
			} catch {
				/* file gone so treat as single line */
			}
			this.cache.set(file, starts);
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
}
