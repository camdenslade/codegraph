import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** `claude` on PATH, an explicit env override, or the VS Code extension binary. */
function resolveClaudeBin(): string {
	if (process.env.CODEGRAPH_EVAL_CLAUDE_BIN) {
		return process.env.CODEGRAPH_EVAL_CLAUDE_BIN;
	}
	const exe = platform() === "win32" ? "claude.exe" : "claude";
	const extRoot = join(homedir(), ".vscode", "extensions");
	try {
		const dirs = readdirSync(extRoot)
			.filter((d) => d.startsWith("anthropic.claude-code-"))
			.sort()
			.reverse();
		for (const d of dirs) {
			const p = join(extRoot, d, "resources", "native-binary", exe);
			if (existsSync(p)) return p;
		}
	} catch {
		/* no extensions dir */
	}
	return "claude"; // hope it is on PATH
}

/**
 * Drives a headless `claude -p` run. Condition B gets a CodeGraph MCP server
 * scoped to the task repo; condition A has the codegraph tools disallowed and
 * is told to use grep/read. Uses `claude` on PATH, else
 * CODEGRAPH_EVAL_CLAUDE_BIN, else the VS Code extension's bundled binary.
 */
export const claudeDriver: AgentDriver = {
	name: "claude-cli",
	async run(req: AgentRunRequest): Promise<AgentRunOutput> {
		const bin = resolveClaudeBin();
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
			args.push(
				"--mcp-config",
				cfg,
				"--allowedTools",
				"mcp__codegraph",
				"--append-system-prompt",
				"You have a CodeGraph MCP server: tools prefixed `mcp__codegraph__` " +
					"(find_symbol, get_symbol_neighborhood, find_path, get_edit_impact, " +
					"get_architectural_skeleton, refresh). For structural questions - callers, " +
					"callees, paths, blast radius, architecture - use these instead of grepping " +
					"and reading files. Call find_symbol first to resolve a name, then the " +
					"relevant graph tool. Fall back to Read/Grep only when a result is " +
					"truncated or the graph cannot answer.",
			);
		} else {
			args.push(
				"--disallowedTools",
				"mcp__codegraph",
				"--append-system-prompt",
				"You do NOT have a code graph tool. Locate code with Grep, Glob and Read only.",
			);
		}

		const t0 = Date.now();
		const timeoutMs = Number(
			process.env.CODEGRAPH_EVAL_RUN_TIMEOUT_MS ?? 300_000,
		);
		let out: string;
		try {
			out = await spawnCollect(bin, args, req.repoRoot, timeoutMs);
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

		const reduced = reduceEvents(events, Date.now() - t0);
		return {
			...reduced,
			transcript: events,
			error:
				runError(events) ??
				(req.condition === "B" ? mcpNotConnected(events) : undefined),
		};
	},
};

// Result subtypes that mean the agent stopped on its own budget, not that the
// model was unavailable. These score as an ordinary FAIL; the sweep continues.
const BENIGN_RESULT_SUBTYPES = new Set([
	"success",
	"error_max_turns",
	"error_during_execution",
]);

/** A short description of how a run ended abnormally, or undefined if it was fine. */
function runError(events: Record<string, unknown>[]): string | undefined {
	if (isModelUnavailable(events)) return "rate limited / out of credits";
	const result = events.find((e) => e.type === "result") as
		| { subtype?: string; is_error?: boolean }
		| undefined;
	if (!result) {
		return events.length === 0 ? "no output from claude" : undefined;
	}
	if (result.subtype && !BENIGN_RESULT_SUBTYPES.has(result.subtype)) {
		return `model error (${result.subtype})`;
	}
	if (result.subtype && result.subtype !== "success") {
		return result.subtype; // e.g. "error_max_turns" - shown, not fatal
	}
	return undefined;
}

/**
 * True only when the run ended because the model itself was unavailable - a
 * blocking rate-limit / exhausted-credits signal. `run.ts` aborts the sweep on
 * this so it does not burn the rest of the quota on empty runs. A plain
 * out-of-turns stop is NOT this.
 */
function isModelUnavailable(events: Record<string, unknown>[]): boolean {
	const rl = [...events]
		.reverse()
		.find((e) => e.type === "rate_limit_event") as
		| {
				rate_limit_info?: { status?: string; overageStatus?: string };
		  }
		| undefined;
	const info = rl?.rate_limit_info;
	if (!info?.status) return false;
	// `status` is "allowed" / "allowed_warning" normally; anything else
	// (e.g. "rejected", "blocked") means the request was refused. A rejected
	// `overageStatus` on its own is not blocking - it just means overage
	// billing is off while the base quota still has room.
	return !/^allowed/.test(info.status);
}

/** If the codegraph MCP server did not connect, return a short reason. */
function mcpNotConnected(
	events: Record<string, unknown>[],
): string | undefined {
	const init = events.find(
		(e) => e.type === "system" && e.subtype === "init",
	);
	const servers = (init?.mcp_servers ?? []) as { name: string; status: string }[];
	const cg = servers.find((s) => s.name === "codegraph");
	if (!cg) return "codegraph MCP not present in init";
	if (cg.status !== "connected") return `codegraph MCP ${cg.status}`;
	return undefined;
}

function spawnCollect(
	bin: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(bin, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				// The codegraph MCP server can take a few seconds to spin up on
				// a cold Node process; keep the client from giving up on it.
				MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? "60000",
				MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? "120000",
			},
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(p.pid);
			p.kill("SIGKILL");
		}, timeoutMs);

		p.stdout.on("data", (d) => (stdout += d));
		p.stderr.on("data", (d) => (stderr += d));
		p.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		p.on("close", (code) => {
			clearTimeout(timer);
			// `claude` spawns the MCP server as a child; on Windows it is not
			// always reaped when the parent exits. Make sure it is gone before
			// the next task spawns its own.
			killTree(p.pid);
			if (timedOut) {
				// Return partial output so the run still scores, flagged.
				resolve(stdout);
				return;
			}
			if (code === 0 || stdout.length > 0) resolve(stdout);
			else
				reject(
					new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`),
				);
		});
	});
}

/** Best-effort kill of a process and its descendants. */
function killTree(pid: number | undefined): void {
	if (!pid) return;
	try {
		if (platform() === "win32") {
			spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
				stdio: "ignore",
			});
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		/* already gone */
	}
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
