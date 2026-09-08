# Evaluation harness

Measures whether CodeGraph makes an LLM agent faster and more correct on real
structural tasks, versus grep + read alone (requirements §9).

## What it does

For each task in `tasks/`, it runs the agent twice:

- **Condition A** - the agent has Grep / Glob / Read only, and is told it has no
  code graph.
- **Condition B** - the agent has the CodeGraph MCP server scoped to the task
  repo, and the codegraph tools allowed.

Same model, same prompt, same turn cap. It captures per run:

- pass / fail against the task's rubric (deterministic string containment)
- total tokens, file reads, graph calls, turns, wall time, cost
- edited files (for `change` tasks)
- whether any CodeGraph result in the transcript was truncated or heuristic

Then it writes an aggregate report (`report.md` + `report.json`): pass-rate
delta, median token delta, file-read delta, and the EV-6 honesty check (how
often a weak graph signal preceded a wrong answer).

## Running

```bash
npm run build

# Self-test the rig with the deterministic mock driver (no API key).
npm run eval

# Real runs against a headless `claude`.
npm run eval -- --driver claude --model claude-sonnet-5

# One task, live.
npm run eval -- --driver claude --only callers-hashText
```

Flags: `--driver mock|claude`, `--only <taskId>`, `--max-turns <n>` (default 20),
`--model <id>`, `--out <path>` (default `eval/report.md`).

The `claude` driver needs the `claude` CLI on PATH, or set
`CODEGRAPH_EVAL_CLAUDE_BIN` to its path. It shells out with
`-p ... --output-format stream-json`; condition B gets a generated `--mcp-config`
pointing at `codegraph serve -C <repo>`.

The harness ingests each task's repo once before running it.

## Tasks

A task is a JSON file in `tasks/`:

```json
{
	"id": "callers-hashText",
	"repo": "self",
	"kind": "comprehension",
	"prompt": "Which functions call `hashText`? ...",
	"rubric": {
		"expectSymbols": ["ingest", "incrementalUpdate"],
		"expectFiles": ["src/ingest/index.ts"],
		"forbid": ["structuralParse"]
	}
}
```

- `repo` - `"self"` (this repo) or an absolute path.
- `kind` - `comprehension` (score the answer text) or `change` (also score which
  files were edited via `expectEdits` / `forbidEdits`).
- `rubric.expectSymbols` / `expectFiles` - substrings the answer must contain.
- `rubric.forbid` - substrings that must NOT appear (hallucinated call sites,
  wrong conclusions).

The seed set is five comprehension tasks on this repo, enough to prove the rig
end to end. The real §9 set - 15 to 25 rubric-scored tasks on 2 to 3
open-source TypeScript repos plus a dogfood repo - drops into `tasks/` the same
way.

## Limitations of the rig

- Rubric scoring is string containment, not semantic. It rewards an answer that
  names the right symbols and does not name wrong ones; it will not catch a
  right-symbols-wrong-explanation answer.
- The mock driver is a stand-in that runs one graph query or one grep and
  echoes the result. It is for testing the harness, not for producing numbers.
- `change` tasks run the agent against a throwaway copy of the repo; the harness
  does not build or test the result, only checks which files were touched.
