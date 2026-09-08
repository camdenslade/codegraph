import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ingest } from "../src/ingest/index.js";
import { dumpGraph } from "../src/query/dump.js";
import { getEditImpact } from "../src/query/impact.js";
import { getSkeleton } from "../src/query/skeleton.js";

const here = fileURLToPath(new URL(".", import.meta.url));

describe("java analyzer (M1 level)", () => {
	let dump: ReturnType<typeof dumpGraph>;
	let repo: string;

	beforeAll(() => {
		process.env.CODEGRAPH_CACHE_DIR = mkdtempSync(
			join(tmpdir(), "cg-java-cache-"),
		);
		repo = mkdtempSync(join(tmpdir(), "cg-java-repo-"));
		cpSync(join(here, "fixtures", "java-app"), repo, { recursive: true });
		ingest(repo, { fresh: true });
		dump = dumpGraph(repo);
	});

	it("extracts types and methods", () => {
		const byKind = (k: string) =>
			dump.nodes
				.filter((n) => n.kind === k)
				.map((n) => n.qualified_name)
				.sort();
		expect(byKind("class")).toEqual([
			"src/main/java/com/x/model/User.java:User",
			"src/main/java/com/x/repo/UserController.java:UserController",
			"src/main/java/com/x/repo/UserRepo.java:UserRepo",
		]);
		expect(byKind("interface")).toEqual([
			"src/main/java/com/x/repo/Repo.java:Repo",
		]);
		expect(byKind("method")).toContain(
			"src/main/java/com/x/repo/UserRepo.java:UserRepo.all",
		);
	});

	it("resolves an in-repo import to a module edge", () => {
		const imports = dump.edges
			.filter((e) => e.kind === "IMPORTS")
			.map((e) => `${e.src} -> ${e.dst}`);
		expect(imports).toContain(
			"module:src/main/java/com/x/repo/UserRepo.java -> module:src/main/java/com/x/model/User.java",
		);
	});

	it("resolves IMPLEMENTS via same-package lookup", () => {
		const impl = dump.edges.find((e) => e.kind === "IMPLEMENTS");
		expect(impl).toBeDefined();
		expect(impl!.src).toBe(
			"class:src/main/java/com/x/repo/UserRepo.java:UserRepo",
		);
		expect(impl!.dst).toBe(
			"interface:src/main/java/com/x/repo/Repo.java:Repo",
		);
		expect(impl!.resolution).toBe("resolved");
	});

	it("records java.util.List as an unresolved import", () => {
		const ext = dump.unresolved.filter(
			(u) => u.kind === "import" && u.text === "java.util.List",
		);
		expect(ext.length).toBeGreaterThan(0);
	});

	it("resolves cross-file method calls via declared types", () => {
		const calls = dump.edges
			.filter((e) => e.kind === "CALLS")
			.map((e) => `${e.src} -> ${e.dst}`);
		// UserRepo.all() does `new User().name()`
		expect(calls).toContain(
			"method:src/main/java/com/x/repo/UserRepo.java:UserRepo.all -> method:src/main/java/com/x/model/User.java:User.name",
		);
	});

	it("extracts Spring routes with class-level prefix and links the handler", () => {
		const routes = dump.nodes
			.filter((n) => n.kind === "route")
			.map((n) => n.name)
			.sort();
		expect(routes).toEqual([
			"GET /api/users",
			"POST /api/users/{id}/promote",
		]);

		const handles = dump.edges
			.filter((e) => e.kind === "HANDLES")
			.map((e) => `${e.src} -> ${e.dst}`);
		expect(handles).toContain(
			"route:src/main/java/com/x/repo/UserController.java:GET /api/users -> " +
				"method:src/main/java/com/x/repo/UserController.java:UserController.list",
		);
	});

	it("resolves an injected-field call: UserController.list -> UserRepo.all", () => {
		const calls = dump.edges
			.filter((e) => e.kind === "CALLS")
			.map((e) => `${e.src} -> ${e.dst}`);
		expect(calls).toContain(
			"method:src/main/java/com/x/repo/UserController.java:UserController.list -> " +
				"method:src/main/java/com/x/repo/UserRepo.java:UserRepo.all",
		);
	});

	it("groups modules into import-coupled clusters in the skeleton", () => {
		const sk = getSkeleton(repo);
		expect(sk.clusters.length).toBeGreaterThan(0);
		// the frontend api.ts, the java repo/model/controller files, all import
		// something in-repo, so they land in real clusters, not "isolated".
		const clustered = new Set(sk.clusters.flatMap((c) => c.modules));
		expect(
			clustered.has("src/main/java/com/x/repo/UserController.java"),
		).toBe(true);
		expect(clustered.has("frontend/api.ts")).toBe(true);
	});

	it("reports edit impact: callers + the routes that reach a symbol", () => {
		const impact = getEditImpact(
			repo,
			"method:src/main/java/com/x/repo/UserRepo.java:UserRepo.all",
			3,
		);
		expect(impact.direct.map((s) => s.name)).toContain("list"); // UserController.list
		// GET /api/users -> list -> all, so the route is in the transitive reach
		expect(impact.routes.map((s) => s.name)).toContain("GET /api/users");
		expect(impact.meta.blastRadius).toBeGreaterThan(0);
	});

	it("links a frontend apiRequest call to its Spring route (cross-language)", () => {
		const xlang = dump.edges
			.filter(
				(e) =>
					e.kind === "CALLS" &&
					typeof e.src === "string" &&
					e.src.startsWith("function:frontend/api.ts") &&
					typeof e.dst === "string" &&
					e.dst.startsWith("route:"),
			)
			.map((e) => `${e.src} -> ${e.dst}`);
		expect(xlang).toContain(
			"function:frontend/api.ts:loadUsers -> " +
				"route:src/main/java/com/x/repo/UserController.java:GET /api/users",
		);
		expect(xlang).toContain(
			"function:frontend/api.ts:promoteUser -> " +
				"route:src/main/java/com/x/repo/UserController.java:POST /api/users/{id}/promote",
		);
	});
});
