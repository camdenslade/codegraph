# MCP server

`codegraph serve` runs an MCP server over stdio (JSON-RPC on stdin/stdout).
Nothing else may write to stdout while it runs.

## Registering it

Point `-C` at the repo you want indexed. User scope (`~/.claude.json`) or a
project `.mcp.json`:

```json
{
	"mcpServers": {
		"codegraph": {
			"command": "node",
			"args": [
				"/abs/path/to/codegraph/dist/cli.js",
				"-C",
				"/abs/path/to/your/repo",
				"serve"
			]
		}
	}
}
```

Run `npm run build` first (the server runs from `dist/`). To index more than
one repo, register more than one server entry with different names and `-C`
values.

On first launch with a cold cache the server ingests the repo, reporting
progress on stderr, then answers. A warm cache answers `find_symbol` within a
couple of seconds of launch.

## Tools

### `find_symbol(query, format?)`

Fuzzy name lookup. Returns candidates with kind and location. Call this first to
turn a bare name into an unambiguous target for the other tools.

- `query` - bare name, `Class.method`, `file.ts:name`, qualified name, or node id.
- `format` - `"json"` (default) or `"text"`.

### `get_symbol_neighborhood(symbol, depth?, direction?, full?, format?)`

Callers, callees, imports, and type relations around a symbol, within N hops.
Signatures and `file:line` only, never bodies.

- `symbol` - as above; run `find_symbol` first if unsure.
- `depth` - 1 to 3, default 2.
- `direction` - `"upstream"`, `"downstream"`, `"both"` (default).
- `full` - `true` to emit every reachable node/edge with no token budget. Use
  when the default result reports `meta.truncated`.
- `format` - `"json"` (default) or `"text"`.

Treat it as a lead, not ground truth. Before concluding, check:

- `meta.truncated` - whether nodes were dropped to fit the budget.
- `meta.total_neighbors` vs `meta.shown_neighbors` - how complete the list is.
- `meta.unresolved_in_scope` - the seed's own unresolved references.
- `meta.notes` - caveats, e.g. that a Java seed's call resolution is syntactic
  and chained calls are missing.

### `find_path(from_symbol, to_symbol, max_len?, format?)`

Shortest directed path from one symbol to another along `CALLS` / `HANDLES` /
`IMPORTS`, or a report that none exists within `max_len` (default 8).

### `get_edit_impact(symbol, max_hops?, format?)`

The blast radius of changing `symbol`, to plan a refactor before touching code:

- `direct` - 1-hop callers and references.
- `transitive` - 2+ hop callers, up to `max_hops` (default 3, max 5).
- `overrides` - methods in subtypes that override the seed (for a method).
- `routes` - route nodes whose handler chain reaches the seed.
- `moduleImporters` - count of modules importing the seed's module (broad
  signal, not enumerated).
- `meta.estReviewTokens` - rough cost of reading the direct sites.
- `meta.resolved` / `meta.heuristic`, `meta.notes` - how much to trust it (Java
  chained-call sites are missing; heuristic edges are flagged).

### `get_architectural_skeleton(format?)`

The module graph (files + import edges) plus each module's exported symbol
names, and `clusters` - modules grouped into import-coupled areas with a
path-summary label and internal/crossing edge counts. No bodies. Use to orient
in an unfamiliar codebase.

### `refresh()`

Runs an incremental update of the graph and returns the change report.

## The `meta` block

Every tool result carries `meta`:

```json
{
	"resolution_summary": { "resolved": 12, "heuristic": 1 },
	"unresolved_in_scope": [
		{ "kind": "call", "text": "someLibFn", "file": "src/x.ts", "line": 40 }
	],
	"truncated": false,
	"truncation_reason": null,
	"total_neighbors": 63,
	"shown_neighbors": 63,
	"notes": []
}
```

- `resolution_summary` - counts of `resolved` vs `heuristic` edges in the result.
- `unresolved_in_scope` - the seed node's own unresolved references (not every
  neighbor's, which would be noise).
- `truncated` - `true` only when nodes were actually dropped.
- `truncation_reason` - what the serializer did to fit the budget (dropped
  `REFERENCES`, reduced depth, compacted detail, omitted N of M neighbors).
- `total_neighbors` / `shown_neighbors` - always present, so you know if the
  list is complete without re-querying.
- `notes` - language-level caveats.

## Response shape

The server returns one `content` text block. For `text` format it is a compact
outline with a `META` section appended. For `json` format it is a JSON object
with `seed`, `nodes`, `edges`, `omitted`, and `meta`. The `meta` is also
appended as a short footer to non-neighborhood text results.

`structuredContent` is not used - some clients surface it and hide `content`,
which would hide the answer.
