#!/usr/bin/env node
import { Command } from "commander";
import { ingest } from "./ingest/index.js";
import { findPath, type FindPathResult } from "./query/path.js";
import { findSymbol } from "./query/find-symbol.js";
import { getNeighborhood, type Direction } from "./query/neighborhood.js";
import { serializeNeighborhood } from "./query/serialize.js";
import { getStats, type Stats } from "./query/stats.js";
import { getSkeleton } from "./query/skeleton.js";
import { runServer } from "./mcp/server.js";
import { openDB } from "./store/db.js";

const program = new Command();
program
	.name("codegraph")
	.description("Semantic code graph, served over MCP")
	.version("0.0.1")
	.option("-C, --repo <path>", "repo root for query commands", ".");

const repoRoot = (): string => program.opts().repo as string;

function resolveSymbolOrExit(query: string): string {
	const cands = findSymbol(repoRoot(), query);
	if (cands.length === 0) {
		console.error(`no symbol matching "${query}"`);
		process.exit(1);
	}
	const top = cands[0]!;
	const tied = cands.filter((c) => c.score === top.score);
	if (tied.length > 1) {
		console.error(
			`"${query}" is ambiguous — disambiguate with file.ts:name or the qualified name:`,
		);
		for (const c of tied.slice(0, 10)) {
			console.error(
				`  ${c.qualifiedName}  (${c.kind})  ${c.file}:${c.line}`,
			);
		}
		process.exit(1);
	}
	return top.id;
}

program
	.command("ingest")
	.description("full build of the graph for a repo")
	.argument("<path>", "repo root")
	.action((path: string) => {
		const r = ingest(path, { fresh: true }); // FR-CLI-1: ingest is always a full build
		console.log(
			`parsed ${r.filesParsed}/${r.filesDiscovered} files · ${r.nodeCount} nodes · ` +
				`${r.edgeCount} edges · ${r.unresolvedCount} unresolved · ${r.filesErrored} errors · ${r.elapsedMs}ms`,
		);
	});

program
	.command("stats")
	.description("node/edge counts, resolution rate, ingest time")
	.argument("[path]", "repo root", ".")
	.action((path: string) => {
		printStats(getStats(path));
	});

program
	.command("skeleton")
	.description("module grapg + per-module exports (FR-SLICE-6)")
	.argument("[path]", "repo root", ".")
	.option("--json", "emit JSON instead of text", false)
	.action((path: string, opts: { json: boolean }) => {
		const sk = getSkeleton(path);
		if (opts.json) {
			console.log(JSON.stringify(sk, null, 2));
			return;
		}
		for (const m of sk.modules) {
			console.log(m.path);
			for (const name of m.exports) console.log(`  · ${name}`);
		}
		console.log(`\nimports (${sk.imports.length})`);
		for (const e of sk.imports)
			console.log(`  ${e.fromPath} -> ${e.toPath}`);
	});

program
	.command("find <query>")
	.description("fuzzy symbol lookup (FR-CLI / FR-MCP-2)")
	.action((q: string) => {
		const cands = findSymbol(repoRoot(), q);
		if (cands.length === 0) {
			console.log("no matches");
			return;
		}
		for (const c of cands) {
			console.log(
				`${String(c.score).padStart(3)}  ${c.kind.padEnd(10)} ${c.qualifiedName}  ${c.file}:${c.line}`,
			);
		}
	});

const query = program.command("query").description("read the graph");

query
	.command("neighborhood <symbol>")
	.description("egocentric subgraph (FR-CLI-2)")
	.option("--depth <n>", "hops, max 3", "2")
	.option("--dir <direction>", "upstream | downstream | both", "both")
	.option("--format <fmt>", "text | json", "text")
	.action(
		(
			symbol: string,
			opts: { depth: string; dir: Direction; format: "text" | "json" },
		) => {
			const id = resolveSymbolOrExit(symbol);
			const nh = getNeighborhood(
				repoRoot(),
				id,
				Number(opts.depth),
				opts.dir,
			);
			console.log(
				serializeNeighborhood(nh, { format: opts.format }).content,
			);
		},
	);

query
	.command("path <from> <to>")
	.description(
		"shortest directed path along CALLS/HANDLES/IMPORTS (FR-CLI-3)",
	)
	.option("--max <n>", "max hops", "8")
	.option("--format <fmt>", "text | json", "text")
	.action(
		(
			from: string,
			to: string,
			opts: { max: string; format: "text" | "json" },
		) => {
			const r = findPath(
				repoRoot(),
				resolveSymbolOrExit(from),
				resolveSymbolOrExit(to),
				Number(opts.max),
			);
			if (opts.format === "json") {
				console.log(JSON.stringify(r, null, 2));
				return;
			}
			printPath(r);
		},
	);

program
	.command("serve")
	.description("start the MCP stdio server (FR-CLI-5)")
	.action(async () => {
		const root = repoRoot();

		// FR-MCP-4: cold cache -> ingest first, progress to stderr (stdout is the
		// JSON-RPC channel and must stay clean).
		const db = openDB(root);
		const count = (
			db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }
		).n;
		db.close();

		if (count === 0) {
			process.stderr.write("codegraph: cold cache, ingesting…\n");
			const r = ingest(root, { fresh: true });
			process.stderr.write(
				`codegraph: ${r.filesParsed} files, ${r.nodeCount} nodes, ` +
					`${r.edgeCount} edges in ${r.elapsedMs}ms\n`,
			);
		}

		await runServer(root);
	});

program.parseAsync();

function printPath(r: FindPathResult): void {
	if (!r.found) {
		console.log(r.message ?? "no path found");
		return;
	}
	console.log(`path (${r.length} hop${r.length === 1 ? "" : "s"})`);
	r.nodes.forEach((n, i) => {
		console.log(`  ${n.kind} ${n.name}  ${n.location}`);
		const step = r.steps[i];
		if (step) console.log(`    | ${step.kind}  ${step.at}`);
	});
}

function printStats(s: Stats): void {
	const line = (label: string, value: unknown) =>
		console.log(` ${label.padEnd(18)} ${value}`);

	console.log(`repo: ${s.repoRoot}`);
	console.log(`\nnodes (${s.nodeTotal})`);
	for (const [k, n] of Object.entries(s.nodesByKind).sort()) line(k, n);
	console.log(`\nedges (${s.edgeTotal})`);
	if (s.edgeTotal === 0) line("(none yet)", "");
	for (const [k, n] of Object.entries(s.edgesByKind).sort()) line(k, n);

	console.log(`\nresolution`);
	line("resolved", s.resolvedEdges);
	line("heuristic", s.heuristicEdges);
	line("unresolved", s.unresolvedCount);
	for (const [k, n] of Object.entries(s.unresolvedByKind).sort()) {
		line(`  ${k}`, n);
	}
	line(
		"rate",
		s.resolutionRate === null
			? "n/a"
			: `${(s.resolutionRate * 100).toFixed(1)}%`,
	);

	console.log(`\ncalls (SC-3)`);
	line("resolved", s.callsResolved);
	line("heuristic", s.callsHeuristic);
	line("unresolved", s.callsUnresolved);
	line(
		"rate",
		s.callResolutionRate === null
			? "n/a"
			: `${(s.callResolutionRate * 100).toFixed(1)}%`,
	);

	console.log(`\nhealth`);
	line("parse errors", s.parseErrors);
	line("ingest time", s.ingestMs === null ? "n/a" : `${s.ingestMs}ms`);
	line(
		"ingested",
		s.ingestedAt === null ? "never" : new Date(s.ingestedAt).toISOString(),
	);
}
