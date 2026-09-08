import type { Condition, Scored } from "./schema.js";

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function agg(rows: Scored[]) {
	const n = rows.length;
	return {
		n,
		passRate: n ? rows.filter((r) => r.pass).length / n : 0,
		medTokens: median(rows.map((r) => r.metrics.totalTokens)),
		medFileReads: median(rows.map((r) => r.metrics.fileReads)),
		medGraphCalls: median(rows.map((r) => r.metrics.graphCalls)),
		medTurns: median(rows.map((r) => r.metrics.numTurns)),
		wrongEdits: rows.filter((r) =>
			r.reasons.some((x) => x.includes("forbidden file")),
		).length,
	};
}

/** EV-4 report. `scored` holds A and B rows for each task. */
export function buildReport(scored: Scored[]): string {
	const byCond: Record<Condition, Scored[]> = { A: [], B: [] };
	for (const s of scored) byCond[s.condition].push(s);
	const a = agg(byCond.A);
	const b = agg(byCond.B);

	const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
	const delta = (x: number, y: number) =>
		y === 0 ? "n/a" : `${(((x - y) / y) * 100).toFixed(0)}%`;

	const out: string[] = [];
	out.push("# CodeGraph evaluation");
	out.push("");
	out.push(`${byCond.A.length} tasks, conditions A (grep/read) vs B (+CodeGraph).`);
	out.push("");
	out.push("## Aggregate");
	out.push("");
	out.push("| metric | A | B | delta |");
	out.push("|---|---|---|---|");
	out.push(`| pass rate | ${pct(a.passRate)} | ${pct(b.passRate)} | ${(b.passRate - a.passRate >= 0 ? "+" : "")}${((b.passRate - a.passRate) * 100).toFixed(0)}pp |`);
	out.push(`| median total tokens | ${a.medTokens} | ${b.medTokens} | ${delta(b.medTokens, a.medTokens)} |`);
	out.push(`| median file reads | ${a.medFileReads} | ${b.medFileReads} | ${delta(b.medFileReads, a.medFileReads)} |`);
	out.push(`| median graph calls | ${a.medGraphCalls} | ${b.medGraphCalls} | - |`);
	out.push(`| median turns | ${a.medTurns} | ${b.medTurns} | ${delta(b.medTurns, a.medTurns)} |`);
	out.push(`| wrong-file edits | ${a.wrongEdits} | ${b.wrongEdits} | - |`);
	out.push("");

	const fc = byCond.B.filter((r) => r.falseConfidence);
	out.push("## EV-6 honesty check");
	out.push("");
	out.push(
		`${byCond.B.filter((r) => r.sawWeakSignal).length}/${byCond.B.length} B-runs saw a truncated/heuristic graph result. ` +
			`${fc.length} of those still produced a wrong answer (false confidence).`,
	);
	if (fc.length) {
		out.push("");
		for (const r of fc) out.push(`- ${r.taskId}: ${r.reasons.join("; ")}`);
	}
	out.push("");

	out.push("## Per task");
	out.push("");
	out.push("| task | A pass | A tok | A reads | B pass | B tok | B reads | B graph |");
	out.push("|---|---|---|---|---|---|---|---|");
	const ids = [...new Set(scored.map((s) => s.taskId))].sort();
	for (const id of ids) {
		const ra = byCond.A.find((s) => s.taskId === id);
		const rb = byCond.B.find((s) => s.taskId === id);
		const cell = (r?: Scored) =>
			r
				? `${r.pass ? "pass" : "FAIL"} | ${r.metrics.totalTokens} | ${r.metrics.fileReads}`
				: "- | - | -";
		out.push(
			`| ${id} | ${cell(ra)} | ${rb ? `${rb.pass ? "pass" : "FAIL"} | ${rb.metrics.totalTokens} | ${rb.metrics.fileReads} | ${rb.metrics.graphCalls}` : "- | - | - | -"} |`,
		);
	}
	out.push("");

	const fails = scored.filter((s) => !s.pass);
	if (fails.length) {
		out.push("## Failures");
		out.push("");
		for (const f of fails) {
			out.push(`### ${f.taskId} (${f.condition})`);
			for (const r of f.reasons) out.push(`- ${r}`);
			out.push("");
		}
	}

	return out.join("\n");
}
