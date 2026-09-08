# CodeGraph

Parse a codebase into a semantic graph of symbols and relationships, then serve
precise structural slices of it to an LLM coding agent over the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP).

The point: an agent asks "what calls this function", "what does this endpoint
touch", "trace the path from handler to DB" and gets a small, exact answer in
one call, instead of grepping and reading whole files. Fewer tokens on
navigation means more tokens for the actual change.

```
codegraph ingest .
codegraph query neighborhood handleRegistrationSubmit --dir upstream
codegraph query path routeHandler saveUser
codegraph serve            # MCP stdio server
```

Status: pre-1.0. TypeScript is fully supported; Java has an import graph, a
syntactic call graph, and Spring MVC routes; frontend HTTP calls are linked to
backend routes so `query path` crosses the language boundary. See
[Limitations](docs/limitations.md).

---

## Why a graph

Text search finds code that shares a keyword. It does not find the callers of a
function, the route that reaches an endpoint, or the blast radius of a change to
a shared util. Those are graph questions, and they are the ones that matter when
you are changing code you did not write.

CodeGraph builds the graph once (a few seconds for a mid-size repo), keeps it
fresh incrementally, and answers those questions from SQLite in single-digit
milliseconds.

Every edge is labelled `resolved` or `heuristic`, and everything the analyzer
could not resolve is reported. The graph tells you when to still open the file.

---

## Install

Requires Node 20+.

```bash
git clone <repo-url> codegraph
cd codegraph
npm install
npm run build
```

`npm install` pulls prebuilt native binaries for `better-sqlite3` and the
`tree-sitter` grammars. No compiler toolchain is needed on macOS, Linux, or
Windows.

For development you can skip the build and run through `tsx`:

```bash
npm run dev -- ingest .
```

---

## Quickstart

```bash
# Build the graph for a repo (full rebuild).
node dist/cli.js ingest /path/to/repo

# Or, from inside the repo:
cd /path/to/repo && node /path/to/codegraph/dist/cli.js ingest .

# Inspect it.
codegraph stats /path/to/repo
codegraph skeleton /path/to/repo

# Query it.
codegraph -C /path/to/repo find apiRequest
codegraph -C /path/to/repo query neighborhood apiRequest --dir upstream
codegraph -C /path/to/repo query path apiRequest saveUser

# Keep it fresh.
codegraph refresh /path/to/repo
codegraph refresh /path/to/repo --watch
```

The graph is cached in an OS-appropriate cache directory keyed by the repo's
absolute path. It never writes inside the target repo.

See [docs/cli.md](docs/cli.md) for the full command reference.

---

## Use with an MCP client (Claude Code, Claude Desktop)

CodeGraph exposes six tools over an MCP stdio server. Register it with your
client, pointing `-C` at the repo you want indexed:

`~/.claude.json` (user scope) or a project `.mcp.json`:

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

On first launch with a cold cache the server ingests the repo (progress on
stderr), then answers. Tools:

| Tool                                                         | Purpose                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `find_symbol(query)`                                         | Fuzzy name lookup, returns candidates with kind + location. Call first to disambiguate.  |
| `get_symbol_neighborhood(symbol, depth?, direction?, full?)` | Callers, callees, imports, and type relations around a symbol.                           |
| `find_path(from_symbol, to_symbol, max_len?)`                | Shortest directed path along `CALLS` / `HANDLES` / `IMPORTS`.                            |
| `get_edit_impact(symbol, max_hops?)`                         | Blast radius before a change: callers, overrides, routes reaching it, review-token cost. |
| `get_architectural_skeleton()`                               | Module graph plus per-module exported names.                                             |
| `refresh()`                                                  | Incremental update of the graph.                                                         |

Every result carries a `meta` block: resolution counts, unresolved symbols in
scope, whether the result was truncated, and `total_neighbors` vs
`shown_neighbors`. See [docs/mcp.md](docs/mcp.md).

---

## The graph

**Nodes** (`nodes` table): `module` (one per file), `function`, `method`,
`class`, `interface`, `type-alias`, `enum`, `variable` (exported top-level),
`record` (Java), `route` (framework handler).

**Edges** (`edges` table), each labelled `resolved` or `heuristic`:

| Edge                     | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `IMPORTS`                | module to module                                                   |
| `DECLARES`               | module to the symbols it declares                                  |
| `CALLS`                  | function/method to the function/method it invokes                  |
| `CALLS` (heuristic)      | client HTTP call to the `route` node it hits (frontend to backend) |
| `REFERENCES`             | non-call use of a symbol (value position)                          |
| `EXTENDS` / `IMPLEMENTS` | class/interface to its supertype                                   |
| `HANDLES`                | route to its handler function/component                            |

So a single `query path` from a React component to a Spring repository method
traverses `clientFn -> route -> HANDLES -> controller -> service -> repo` across
the language boundary.

Anything the analyzer could not bind is recorded in the `unresolved` table with
its kind (`import`, `call`, `heritage`, `reference`, `route`) and source
location, so a query can tell you exactly what it does not know.

---

## Language support

|                          | TypeScript / TSX                            | Java                                                              |
| ------------------------ | ------------------------------------------- | ----------------------------------------------------------------- |
| Discovery                | tsconfig `include`/`exclude` + `.gitignore` | source-tree walk + `.gitignore`                                   |
| Nodes                    | full                                        | classes, interfaces, enums, records, methods                      |
| `IMPORTS`                | tsconfig paths, re-export barrels           | FQN to file (Maven/Gradle layout)                                 |
| `CALLS`                  | TypeScript compiler API (accurate)          | syntactic: fields, locals, params, `this`, `super`, `new`, static |
| `EXTENDS` / `IMPLEMENTS` | compiler API                                | name resolution (import / same-package / unique)                  |
| Routes                   | Express/Fastify, React Router               | Spring MVC (`@GetMapping` etc., class-prefix composed)            |

Java `CALLS` does not do return-type inference, so chained calls (`a.b().c()`)
and stream/lambda pipelines are left `unresolved` and reported. See
[docs/languages.md](docs/languages.md) for the full matrix and how to add a
language.

---

## Performance

Measured on a 349-file repo (216 TS/TSX + 136 Java, ~55k LOC):

|                             |                             |
| --------------------------- | --------------------------- |
| Cold ingest                 | ~9 s                        |
| Incremental update (1 file) | < 1 s                       |
| Depth-2 neighborhood query  | avg 6 ms, worst case ~50 ms |

Zero network calls at runtime. All analysis is local.

---

## Development

```bash
npm run check       # tsc --noEmit && eslint && vitest run
npm test            # vitest run
npm run format      # prettier --write .
npm run build       # tsc -> dist/
```

Tests use golden snapshots and full-vs-incremental equivalence checks on small
fixture repos under `test/fixtures/`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Evaluation

`eval/` is a harness that measures whether CodeGraph makes an agent faster and
more correct than grep + read alone: each task runs twice (grep-only vs
+CodeGraph MCP), and the harness scores against a rubric and reports pass-rate
delta, median token/file-read deltas, and how often a truncated or heuristic
graph result preceded a wrong answer.

```bash
npm run eval                                   # self-test with the mock driver
npm run eval -- --driver claude --model <id>   # real runs
```

Ships with 5 seed tasks; see [eval/README.md](eval/README.md).

---

## Documentation

- [docs/architecture.md](docs/architecture.md) - the ingestion pipeline, the
  `LanguageAnalyzer` interface, the storage schema, the incremental model.
- [docs/cli.md](docs/cli.md) - every command and flag.
- [docs/mcp.md](docs/mcp.md) - the five MCP tools, arguments, and the `meta`
  block.
- [docs/languages.md](docs/languages.md) - per-language capability matrix and a
  guide to adding a language.
- [docs/limitations.md](docs/limitations.md) - known gaps and what is deferred.

---

## Licenses

CodeGraph is MIT licensed. See [LICENSE](LICENSE).

Runtime dependencies and their licenses:

| Package                     | License    |
| --------------------------- | ---------- |
| `@modelcontextprotocol/sdk` | MIT        |
| `better-sqlite3`            | MIT        |
| `chokidar`                  | MIT        |
| `commander`                 | MIT        |
| `ignore`                    | MIT        |
| `tree-sitter`               | MIT        |
| `tree-sitter-typescript`    | MIT        |
| `tree-sitter-java`          | MIT        |
| `typescript`                | Apache-2.0 |

`typescript` (Apache-2.0) is the only non-MIT runtime dependency. Its license is
compatible with MIT distribution; the Apache-2.0 NOTICE terms apply to that
package only.
