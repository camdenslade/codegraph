import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ingest } from "../src/ingest/index.js";
import { dumpGraph } from "../src/query/dump.js";

const here = fileURLToPath(new URL(".", import.meta.url));

describe("route extractors", () => {
	let dump: ReturnType<typeof dumpGraph>;

	beforeAll(() => {
		process.env.CODEGRAPH_CACHE_DIR = mkdtempSync(
			join(tmpdir(), "cg-routes-cache-"),
		);
		const repo = mkdtempSync(join(tmpdir(), "cg-routes-repo-"));
		cpSync(join(here, "fixtures", "routes"), repo, { recursive: true });
		ingest(repo, { fresh: true });
		dump = dumpGraph(repo);
	});

	it("creates a route node per declared route", () => {
		const routes = dump.nodes
			.filter((n) => n.kind === "route")
			.map((n) => n.name)
			.sort();
		expect(routes).toEqual([
			"GET /users",
			"GET /users/:id",
			"POST /users",
			"ROUTE /",
			"ROUTE /about",
		]);
	});

	it("links resolvable handlers with HANDLES edges", () => {
		const handles = dump.edges
			.filter((e) => e.kind === "HANDLES")
			.map((e) => `${e.src} -> ${e.dst}`)
			.sort();
		expect(handles).toEqual([
			"route:api.ts:GET /users -> function:handlers.ts:listUsers",
			"route:api.ts:GET /users/:id -> function:handlers.ts:getUser",
			"route:router.tsx:ROUTE / -> function:handlers.ts:Home",
			"route:router.tsx:ROUTE /about -> function:handlers.ts:Home",
		]);
	});

	it("records an inline handler as an unresolved route", () => {
		const inline = dump.unresolved.filter((u) => u.kind === "route");
		expect(inline).toHaveLength(1);
		expect(inline[0]!.node_id).toBe("route:api.ts:POST /users");
	});
});
