import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
	AgentDriver,
	AgentRunOutput,
	AgentRunRequest,
	RunMetrics,
} from "./schema.js";

const CLI = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"dist",
	"cli.js",
);

const emptyMetrics = (): RunMetrics => ({
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	numTurns: 1,
	wallMs: 0,
	costUsd: 0,
	toolCalls: {},
	fileReads: 0,
	graphCalls: 0,
	editCalls: 0,
	editedFiles: [],
});

/**
 * A deterministic stand-in for a live model, so the harness itself can be
 * tested and demoed without an API key. It answers by actually running the
 * CodeGraph CLI (condition B) or by grepping (condition A), then echoing what
 * it found. It is NOT a real agent - it exists to prove the rig end to end.
 */
const cg = (repoRoot: string, args: string[]): string =>
	execFileSync(process.execPath, [CLI, "-C", repoRoot, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

/** Rough intent from the prompt, so the mock picks a plausible command. */
function intent(
	prompt: string,
): "impact" | "skeleton" | "stats" | "neighborhood" {
	const p = prompt.toLowerCase();
	if (/blast radius|impact|would need review|safe to delete/.test(p)) {
		return "impact";
	}
	if (/architectural area|grouped by how|module.*import each other/.test(p)) {
		return "skeleton";
	}
	if (/unresolved|could not resolve/.test(p)) return "stats";
	return "neighborhood";
}

export const mockDriver: AgentDriver = {
	name: "mock",
	async run(req: AgentRunRequest): Promise<AgentRunOutput> {
		const t0 = Date.now();
		const metrics = emptyMetrics();
		const want = extractSymbol(req.prompt);
		const kind = intent(req.prompt);
		let answer = "";

		try {
			if (req.condition === "B") {
				metrics.graphCalls = 1;
				if (kind === "skeleton") {
					metrics.toolCalls[
						"mcp__codegraph__get_architectural_skeleton"
					] = 1;
					answer = cg(req.repoRoot, ["skeleton"]).split(
						"\nimports",
					)[0]!;
				} else if (kind === "stats") {
					metrics.toolCalls["mcp__codegraph__get_edit_impact"] = 1;
					answer = cg(req.repoRoot, ["stats"]);
				} else if (kind === "impact" && want) {
					metrics.toolCalls["mcp__codegraph__get_edit_impact"] = 1;
					answer = cg(req.repoRoot, [
						"query",
						"impact",
						want,
						"--hops",
						"2",
					]);
				} else if (want) {
					metrics.toolCalls[
						"mcp__codegraph__get_symbol_neighborhood"
					] = 1;
					answer = cg(req.repoRoot, [
						"query",
						"neighborhood",
						want,
						"--dir",
						"both",
						"--depth",
						"1",
					]);
				} else {
					metrics.graphCalls = 0;
					answer = "(mock: no symbol found in prompt)";
				}
			} else if (want) {
				const out = execFileSync(
					"grep",
					[
						"-rn",
						"--include=*.ts",
						"--include=*.java",
						want,
						"src",
						".",
					],
					{
						cwd: req.repoRoot,
						encoding: "utf8",
						stdio: ["ignore", "pipe", "pipe"],
					},
				).slice(0, 8000);
				metrics.fileReads = 1;
				metrics.toolCalls["Grep"] = 1;
				answer = out;
			} else {
				answer = "(mock: no symbol found in prompt)";
			}
		} catch (err) {
			return {
				answer: "",
				metrics,
				transcript: [],
				error: (err as Error).message,
			};
		}

		metrics.wallMs = Date.now() - t0;
		metrics.outputTokens = Math.ceil(answer.length / 4);
		metrics.totalTokens = metrics.outputTokens;
		return { answer, metrics, transcript: [] };
	},
};

function extractSymbol(prompt: string): string | null {
	// Grab the first `identifier` or `Class.method` in backticks, else the first
	// camelCase / PascalCase word.
	const tick = prompt.match(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)`/);
	if (tick) return tick[1]!;
	const word = prompt.match(
		/\b([a-z][a-zA-Z0-9]{3,}|[A-Z][a-zA-Z0-9]{3,})\b/,
	);
	return word ? word[1]! : null;
}
