import { describe, expect, it } from "vitest";
import { buildReport } from "../eval/report.js";
import { score } from "../eval/score.js";
import type { RunMetrics, RunResult, Scored, Task } from "../eval/schema.js";

const metrics = (over: Partial<RunMetrics> = {}): RunMetrics => ({
	inputTokens: 100,
	outputTokens: 50,
	totalTokens: 150,
	numTurns: 2,
	wallMs: 10,
	costUsd: 0,
	toolCalls: {},
	fileReads: 1,
	graphCalls: 0,
	editCalls: 0,
	editedFiles: [],
	...over,
});

const task: Task = {
	id: "t1",
	repo: "self",
	kind: "comprehension",
	prompt: "who calls foo",
	rubric: {
		expectSymbols: ["bar", "baz"],
		expectFiles: ["src/a.ts"],
		forbid: ["qux"],
	},
};

describe("eval scoring", () => {
	it("passes when every expectation is met and nothing forbidden appears", () => {
		const run: RunResult = {
			taskId: "t1",
			condition: "B",
			answer: "bar (src/a.ts) and baz both call foo",
			metrics: metrics(),
			sawWeakSignal: false,
		};
		const s = score(task, run);
		expect(s.pass).toBe(true);
		expect(s.reasons).toEqual([]);
	});

	it("fails and lists every missing expectation", () => {
		const run: RunResult = {
			taskId: "t1",
			condition: "A",
			answer: "only bar calls foo",
			metrics: metrics(),
			sawWeakSignal: false,
		};
		const s = score(task, run);
		expect(s.pass).toBe(false);
		expect(s.reasons).toContain("missing expected symbol: baz");
		expect(s.reasons).toContain("missing expected file: src/a.ts");
	});

	it("fails on a forbidden claim", () => {
		const run: RunResult = {
			taskId: "t1",
			condition: "B",
			answer: "bar, baz, and qux call foo, in src/a.ts",
			metrics: metrics(),
			sawWeakSignal: false,
		};
		const s = score(task, run);
		expect(s.pass).toBe(false);
		expect(s.reasons.some((r) => r.includes("forbidden"))).toBe(true);
	});

	it("flags false confidence: weak graph signal plus a wrong answer (EV-6)", () => {
		const run: RunResult = {
			taskId: "t1",
			condition: "B",
			answer: "just bar",
			metrics: metrics(),
			sawWeakSignal: true,
		};
		const s = score(task, run);
		expect(s.pass).toBe(false);
		expect(s.falseConfidence).toBe(true);
	});

	it("scores change-task edits", () => {
		const changeTask: Task = {
			...task,
			kind: "change",
			rubric: {
				expectEdits: ["src/a.ts"],
				forbidEdits: ["src/b.ts"],
			},
		};
		const run: RunResult = {
			taskId: "t1",
			condition: "B",
			answer: "done",
			metrics: metrics({ editedFiles: ["/repo/src/b.ts"] }),
			sawWeakSignal: false,
		};
		const s = score(changeTask, run);
		expect(s.reasons).toContain("expected edit not made: src/a.ts");
		expect(s.reasons).toContain("edited a forbidden file: src/b.ts");
	});
});

describe("eval report", () => {
	it("renders aggregate deltas and a per-task table", () => {
		const rows: Scored[] = [
			{
				taskId: "t1",
				condition: "A",
				pass: false,
				reasons: ["missing expected symbol: baz"],
				metrics: metrics({ totalTokens: 2000, fileReads: 8 }),
				sawWeakSignal: false,
				falseConfidence: false,
			},
			{
				taskId: "t1",
				condition: "B",
				pass: true,
				reasons: [],
				metrics: metrics({
					totalTokens: 400,
					fileReads: 0,
					graphCalls: 1,
				}),
				sawWeakSignal: false,
				falseConfidence: false,
			},
		];
		const md = buildReport(rows);
		expect(md).toContain("# CodeGraph evaluation");
		expect(md).toContain("pass rate");
		expect(md).toContain("| t1 |");
		expect(md).toContain("EV-6 honesty check");
	});
});
