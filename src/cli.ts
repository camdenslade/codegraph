#!/usr/bin/env node
import { Command } from "commander";
import { ingest } from "./ingest/index.js";
import { getStats, type Stats } from "./query/stats.js";
import { getSkeleton } from "./query/skeleton.js";

const program = new Command();
program
    .name("codegraph")
    .description("Semantic code graph, served over MCP")
    .version("0.0.1")

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
    .action((path: string, opts: { json:boolean }) => {
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
        for (const e of sk.imports) console.log(`  ${e.fromPath} -> ${e.toPath}`);
    })

program.parse();

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
        s.resolutionRate === null ? "n/a" : `${(s.resolutionRate * 100).toFixed(1)}%`,
    );

    console.log(`\ncalls (SC-3)`);
    line("resolved", s.callsResolved);
    line("heuristic", s.callsHeuristic);
    line("unresolved", s.callsUnresolved);
    line(
        "rate",
        s.callResolutionRate === null
            ? "n/a"
            : `${(s.callResolutionRate * 100).toFixed(1)}%`
    );

    console.log(`\nhealth`);
    line("parse errors", s.parseErrors);
    line("ingest time", s.ingestMs === null ? "n/a" : `${s.ingestMs}ms`);
    line(
        "ingested",
        s.ingestedAt === null ? "never" : new Date(s.ingestedAt).toISOString(),
    );
}