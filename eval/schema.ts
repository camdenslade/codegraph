// Task and result types for the CodeGraph evaluation harness (requirements §9).

export type TaskKind = "comprehension" | "change";

export interface Task {
	id: string;
	/** "self" = the codegraph repo, otherwise an absolute path to a repo. */
	repo: string;
	kind: TaskKind;
	prompt: string;
	rubric: Rubric;
}

export interface Rubric {
	/** Symbol names the answer MUST mention (substring match). */
	expectSymbols?: string[];
	/** Repo-relative file paths the answer MUST mention. */
	expectFiles?: string[];
	/** Strings that MUST NOT appear (wrong facts / hallucinated call sites). */
	forbid?: string[];
	/** For change tasks: files the agent is expected to edit. */
	expectEdits?: string[];
	/** For change tasks: files it must NOT edit (regression guard). */
	forbidEdits?: string[];
}

export type Condition = "A" | "B"; // A = grep/read only, B = + CodeGraph MCP

export interface RunMetrics {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	numTurns: number;
	wallMs: number;
	costUsd: number;
	/** tool name -> call count */
	toolCalls: Record<string, number>;
	fileReads: number; // Read + Grep + Glob
	graphCalls: number; // mcp__codegraph__*
	editCalls: number; // Edit + Write + MultiEdit
	editedFiles: string[];
}

export interface RunResult {
	taskId: string;
	condition: Condition;
	answer: string;
	metrics: RunMetrics;
	/** true if any CodeGraph result in the transcript was truncated or heuristic. */
	sawWeakSignal: boolean;
	error?: string;
}

export interface Scored {
	taskId: string;
	condition: Condition;
	pass: boolean;
	reasons: string[]; // why it failed, if it did
	metrics: RunMetrics;
	sawWeakSignal: boolean;
	/** EV-6: a weak graph signal preceded a wrong answer. */
	falseConfidence: boolean;
}

export interface AgentRunRequest {
	prompt: string;
	repoRoot: string; // absolute
	condition: Condition;
	maxTurns: number;
	model?: string;
}

export interface AgentRunOutput {
	answer: string;
	metrics: RunMetrics;
	transcript: unknown[]; // raw driver events, for signal extraction
	error?: string;
}

/** Pluggable so the harness can be exercised with a mock instead of a live model. */
export interface AgentDriver {
	name: string;
	run(req: AgentRunRequest): Promise<AgentRunOutput>;
}
