import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
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

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Drives a headless `claude -p` run. Condition B gets a CodeGraph MCP server
 * scoped to the task repo; condition A has the codegraph tools disallowed and
 * is told to use grep/read. Requires the `claude` CLI on PATH (or set
 * CODEGRAPH_EVAL_CLAUDE_BIN).
 */
export const claudeDriver: AgentDriver = {
	name: "claude-cli",
	async run(req: AgentRunRequest): Promise<AgentRunOutput> {
		const bin = process.env.CODEGRAPH_EVAL_CLAUDE_BIN ?? "claude";
		const tmp = mkdtempSync(join(tmpdir(), "cg-eval-"));
		const args = [
			"-p",
			req.prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--max-turns",
			String(req.maxTurns),
		];
		if (req.model) args.push("--model", req.model);

		if (req.condition === "B") {
			const cfg = join(tmp, "mcp.json");
			writeFileSync(
				cfg,
				JSON.stringify({
					mcpServers: {
						codegraph: {
							command: process.execPath,
							args: [CLI, "-C", req.repoRoot, "serve"],
						},
					},
				}),
			);
			args.push("--mcp-config", cfg, "--allowedTools", "mcp__codegraph");
		} else {
			args.push(
				"--disallowedTools",
				"mcp__codegraph",
				"--append-system-prompt",
				"You do NOT have a code graph tool. Locate code with Grep, Glob and Read only.",
			);
		}

		const t0 = Date.now();
		let out: string;
		try {
			out = await spawnCollect(bin, args, req.repoRoot);
		} catch (err) {
			rmSync(tmp, { recursive: true, force: true });
			return {
				answer: "",
				metrics: zero(),
				transcript: [],
				error: (err as Error).message,
			};
		}
		rmSync(tmp, { recursive: true, force: true });

		const events = out
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter((e): e is Record<string, unknown> => e !== null);

		return { ...reduceEvents(events, Date.now() - t0), transcript: events };
	},
};

function spawnCollect(
	bin: string,
	args: string[],
	cwd: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => (stdout += d));
		p.stderr.on("data", (d) => (stderr += d));
		p.on("error", reject);
		p.on("close", (code) => {
			if (code === 0 || stdout.length > 0) resolve(stdout);
			else
				reject(
					new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`),
				);
		});
	});
}

function zero(): RunMetrics {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		numTurns: 0,
		wallMs: 0,
		costUsd: 0,
		toolCalls: {},
		fileReads: 0,
		graphCalls: 0,
		editCalls: 0,
		editedFiles: [],
	};
}

function reduceEvents(
	events: Record<string, unknown>[],
	wallMs: number,
): { answer: string; metrics: RunMetrics } {
	const m = zero();
	m.wallMs = wallMs;
	let answer = "";

	for (const e of events) {
		if (e.type === "assistant" && e.message) {
			const msg = e.message as { content?: unknown[] };
			for (const block of msg.content ?? []) {
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") {
					answer = b.text;
				}
				if (b.type === "tool_use" && typeof b.name === "string") {
					const name = b.name;
					m.toolCalls[name] = (m.toolCalls[name] ?? 0) + 1;
					if (READ_TOOLS.has(name)) m.fileReads++;
					if (name.startsWith("mcp__codegraph")) m.graphCalls++;
					if (EDIT_TOOLS.has(name)) {
						m.editCalls++;
						const fp = (
							b.input as { file_path?: string } | undefined
						)?.file_path;
						if (fp && !m.editedFiles.includes(fp)) {
							m.editedFiles.push(fp);
						}
					}
				}
			}
		}
		if (e.type === "result") {
			const r = e as {
				result?: string;
				num_turns?: number;
				total_cost_usd?: number;
				usage?: { input_tokens?: number; output_tokens?: number };
			};
			if (typeof r.result === "string" && r.result) answer = r.result;
			m.numTurns = r.num_turns ?? m.numTurns;
			m.costUsd = r.total_cost_usd ?? 0;
			m.inputTokens = r.usage?.input_tokens ?? 0;
			m.outputTokens = r.usage?.output_tokens ?? 0;
			m.totalTokens = m.inputTokens + m.outputTokens;
		}
	}
	return { answer, metrics: m };
}
