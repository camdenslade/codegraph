# Changelog

## Unreleased

Pre-1.0. The graph model, the incremental pipeline, both language analyzers, the
five original MCP tools, and the evaluation harness are in place; the §9
evaluation corpus and a second non-Java language are the remaining v1.0 work.

### Added

- **Graph core** - SQLite store, deterministic node ids, recursive-CTE
  neighborhood queries, BFS path-finding, token-budgeted serialization with a
  degradation ladder, `resolved` / `heuristic` / `unresolved` labelling.
- **TypeScript analyzer** - tree-sitter structural pass + TypeScript compiler
  API for `IMPORTS` / `CALLS` / `REFERENCES` (value and type positions) /
  `EXTENDS` / `IMPLEMENTS`. Express/Fastify and React Router route extractors
  (JSX + `createBrowserRouter` object config, guard-component unwrapping).
- **Java analyzer** - tree-sitter-java. Classes/interfaces/enums/records/methods,
  `IMPORTS` by FQN, `EXTENDS` / `IMPLEMENTS` by name resolution, a syntactic
  `CALLS` graph (fields, locals, params, `this`, `super`, `new`, static), and
  Spring MVC route extraction with class-level prefix composition.
- **Cross-language full-stack edges** - frontend `fetch` / `axios.*` /
  `apiRequest` calls linked to Spring route nodes by normalized method + path,
  so `query path` traverses `clientFn -> route -> HANDLES -> controller ->
service -> repo`.
- **Incremental update** (`refresh`, `--watch`) - hash-diff reparse with
  inbound-edge preservation; the TS `Program` is kept warm across watch runs.
- **CLI** - `ingest`, `refresh`, `stats`, `skeleton` (with import-coupled
  module clustering), `find`, `query neighborhood` / `path` / `impact`, `serve`.
- **MCP server** - `find_symbol`, `get_symbol_neighborhood`, `find_path`,
  `get_edit_impact`, `get_architectural_skeleton`, `refresh`. Every result
  carries a `meta` block (resolution counts, unresolved in scope, truncation,
  `total_neighbors` vs `shown_neighbors`, language caveats).
- **Churn-weighted pruning** - per-file git activity, used so a neighborhood
  trimmed to a token budget drops cold code before actively-edited code.
- **Evaluation harness** (`eval/`) - two-condition (grep vs +CodeGraph) runner,
  rubric scoring, aggregate report, EV-6 honesty check, mock and `claude-cli`
  drivers, seed task set.

### Known gaps

See `docs/limitations.md`.
