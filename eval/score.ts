import type { Rubric, RunResult, Scored, Task } from "./schema.js";

/** Apply a task's rubric to one run. Deterministic string containment. */
export function score(task: Task, run: RunResult): Scored {
	const reasons: string[] = [];
	const hay = run.answer.toLowerCase();
	const has = (s: string) => hay.includes(s.toLowerCase());

	if (run.error) reasons.push(`run error: ${run.error}`);

	checkPresence(task.rubric.expectSymbols, has, "symbol", reasons);
	checkPresence(task.rubric.expectFiles, has, "file", reasons);

	for (const bad of task.rubric.forbid ?? []) {
		if (has(bad)) reasons.push(`forbidden claim present: "${bad}"`);
	}

	if (task.kind === "change") {
		checkEdits(task.rubric, run, reasons);
	}

	const pass = reasons.length === 0;
	// EV-6: the graph handed back a weak signal (truncated / heuristic) and the
	// answer is still wrong -> the meta labelling did not stop a bad conclusion.
	const falseConfidence = run.condition === "B" && run.sawWeakSignal && !pass;

	return {
		taskId: task.id,
		condition: run.condition,
		pass,
		reasons,
		metrics: run.metrics,
		sawWeakSignal: run.sawWeakSignal,
		falseConfidence,
	};
}

function checkPresence(
	expected: string[] | undefined,
	has: (s: string) => boolean,
	label: string,
	reasons: string[],
): void {
	for (const e of expected ?? []) {
		if (!has(e)) reasons.push(`missing expected ${label}: ${e}`);
	}
}

function checkEdits(rubric: Rubric, run: RunResult, reasons: string[]): void {
	const edited = run.metrics.editedFiles.map(norm);
	for (const f of rubric.expectEdits ?? []) {
		if (!edited.some((e) => e.endsWith(norm(f)))) {
			reasons.push(`expected edit not made: ${f}`);
		}
	}
	for (const f of rubric.forbidEdits ?? []) {
		if (edited.some((e) => e.endsWith(norm(f)))) {
			reasons.push(`edited a forbidden file: ${f}`);
		}
	}
}

const norm = (p: string) => p.replace(/\\/g, "/");
