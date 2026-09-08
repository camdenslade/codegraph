import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeDriver } from "./driver-claude.js";
import { mockDriver } from "./driver-mock.js";
import { buildReport } from "./report.js";
import { score } from "./score.js";
import type {
	AgentDriver,
	Condition,
	RunResult,
	Scored,
	Task,
} from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
const TASK_DIR = join(HERE, "tasks");

interface Options {
	driver: AgentDriver;
	only?: string; // task id filter
	maxTurns: number;
	model?: string;
	out: string;
}

function parseArgs(argv: string[]): Options {
	const get = (flag: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const driverName = get("--driver") ?? "mock";
	return {
		driver: driverName === "claude" ? claudeDriver : mockDriver,
		only: get("--only"),
		maxTurns: Number(get("--max-turns") ?? 20),
		model: get("--model"),
		out: get("--out") ?? join(HERE, "report.md"),
	};
}

function loadTasks(only?: string): Task[] {
	const tasks = readdirSync(TASK_DIR)
		.filter((f) => f.endsWith(".json"))
		.map(
			(f) => JSON.parse(readFileSync(join(TASK_DIR, f), "utf8")) as Task,
		);
	return only ? tasks.filter((t) => t.id === only) : tasks;
}

function repoRootFor(task: Task): string {
	return task.repo === "self" ? REPO_ROOT : resolve(task.repo);
}

/** Ensure the graph exists for condition B (and for the mock driver). */
function ensureIngested(repoRoot: string): void {
	execFileSync(process.execPath, [CLI, "-C", repoRoot, "ingest"], {
		stdio: "ignore",
	});
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const tasks = loadTasks(opts.only);
	if (tasks.length === 0) {
		console.error("no tasks matched");
		process.exit(1);
	}

	console.error(
		`running ${tasks.length} task(s) x 2 conditions with driver "${opts.driver.name}"`,
	);

	const ingested = new Set<string>();
	const scored: Scored[] = [];

	for (const task of tasks) {
		const repoRoot = repoRootFor(task);
		if (!ingested.has(repoRoot)) {
			ensureIngested(repoRoot);
			ingested.add(repoRoot);
		}

		for (const condition of ["A", "B"] as Condition[]) {
			process.stderr.write(`  ${task.id} [${condition}] ... `);
			const out = await opts.driver.run({
				prompt: task.prompt,
				repoRoot,
				condition,
				maxTurns: opts.maxTurns,
				model: opts.model,
			});
			const run: RunResult = {
				taskId: task.id,
				condition,
				answer: out.answer,
				metrics: out.metrics,
				sawWeakSignal: hasWeakSignal(out),
				error: out.error,
			};
			const s = score(task, run);
			scored.push(s);
			process.stderr.write(
				`${s.pass ? "pass" : "FAIL"} (${out.metrics.totalTokens} tok, ${out.metrics.fileReads} reads)\n`,
			);
		}
	}

	const report = buildReport(scored);
	writeFileSync(opts.out, report + "\n");
	writeFileSync(
		opts.out.replace(/\.md$/, ".json"),
		JSON.stringify(scored, null, 2),
	);
	console.error(`\nwrote ${opts.out}`);
	console.log(report);
}

function hasWeakSignal(out: {
	answer: string;
	transcript: unknown[];
}): boolean {
	const blob = out.answer + JSON.stringify(out.transcript).slice(0, 200000);
	return /truncated:\s*(true|dropped|compact|omitted)|"truncated":\s*true|\[heuristic\]|meta\.notes|call resolution is syntactic/i.test(
		blob,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
