import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ingest } from "../src/ingest/index.js";
import { incrementalUpdate } from "../src/ingest/incremental.js";
import { dumpGraph } from "../src/query/dump.js";

const here = fileURLToPath(new URL(".", import.meta.url));

describe("incremental update", () => {
	let repo: string;

	beforeAll(() => {
		process.env.CODEGRAPH_CACHE_DIR = mkdtempSync(
			join(tmpdir(), "cg-inc-cache-"),
		);
		repo = mkdtempSync(join(tmpdir(), "cg-inc-repo-"));
		cpSync(join(here, "fixtures", "tiny"), repo, { recursive: true });
		ingest(repo, { fresh: true });
	});

	it("no-ops when nothing changed", () => {
		const { report } = incrementalUpdate(repo);
		expect(report.noop).toBe(true);
		expect(report.changed).toEqual([]);
	});

	it("matches a full rebuild after a file changes", () => {
		const f = join(repo, "math.ts");
		writeFileSync(
			f,
			readFileSync(f, "utf8") +
				"\nexport function sub(a: number, b: number) {\n\treturn a - b;\n}\n",
		);

		const { report } = incrementalUpdate(repo);
		expect(report.changed).toEqual(["math.ts"]);
		expect(report.noop).toBe(false);

		const incremental = dumpGraph(repo);
		ingest(repo, { fresh: true });
		expect(incremental).toEqual(dumpGraph(repo));
	});

	it("matches a full rebuild after a file is removed", () => {
		// index.ts is imported by nothing, so no dangling inbound edges.
		rmSync(join(repo, "index.ts"));

		const { report } = incrementalUpdate(repo);
		expect(report.removed).toEqual(["index.ts"]);

		const incremental = dumpGraph(repo);
		ingest(repo, { fresh: true });
		expect(incremental).toEqual(dumpGraph(repo));
	});
});
