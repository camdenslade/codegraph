# Limitations and known gaps

CodeGraph is a lead, not ground truth. This page is the honest list of what it
does not do yet, so you know when to still open the file.

## Resolution

- **Java call graph is syntactic.** Chained calls (`a.b().c()`), stream/lambda
  pipelines, and calls on cast or ternary expressions are `unresolved`, not
  edges. A Java `get_symbol_neighborhood` with few or no `CALLS` does not mean
  the method is unused - `meta.notes` says so on every Java result. See
  [languages.md](languages.md#java-call-resolution).
- **No cross-language edges.** A frontend `apiRequest("/api/users")` string is
  not linked to the backend `@GetMapping("/api/users")` handler. Change-impact
  questions that cross the HTTP boundary cannot be answered from the graph.
- **No type-reference edges.** `get_symbol_neighborhood` on an `interface` or
  `type-alias` returns no edges for the places that use it as a type. "What
  uses this type" degrades to the module-import list, which is broader than the
  real set. `RETURNS_TYPE` / `PARAM_TYPE` edges are planned.
- **`REFERENCES` is TypeScript-only and conservative.** Value-position uses of
  a tracked symbol only. Java has no `REFERENCES` edges.
- **Function overloads collapse.** Two functions with the same qualified name
  produce one node (last wins).
- **`.d.ts` files are skipped.** Types declared only in ambient declarations are
  not nodes; imports resolving to them are unresolved.

## Routes

- **Spring routes are not extracted.** `@GetMapping` / `@RequestMapping` methods
  are plain `method` nodes with no route semantics and are not findable by path.
- **Wrapped React routes collapse to the wrapper.** `<ProtectedRoute><Dues/>
</ProtectedRoute>` links the route to `ProtectedRoute`, not `Dues`, so two
  routes wrapping different pages can look identical from the route graph.
- **React Router object config is not read.** Only JSX `<Route>` elements;
  `createBrowserRouter([...])` / `useRoutes([...])` are ignored.

## Incremental update

- An unchanged caller's edge into a changed file keeps its **old resolution
  label** - it is not re-resolved.
- A removed file leaves unchanged importers with a **silently dropped edge** and
  no `unresolved` record.

Both are corrected by a full `codegraph ingest`. This is the deliberate
FR-INC-2 trade: a single-file refresh stays well under a second by not
reprocessing importers.

## Serving

- **`serve` only detects a cold cache, not a stale one.** A warm-but-outdated
  cache serves old data until `refresh` (manually, or via `--watch`, or the
  `refresh` MCP tool) runs.
- **`--watch` SIGINT cleanup on Windows** occasionally needs a second signal.

## Scale

- Performance is validated on a ~350-file / ~55k-LOC repo (~9 s cold ingest,
  ~6 ms median depth-2 query). It has not been profiled on a 500k-LOC
  monorepo; the recursive-CTE neighborhood query is the component most likely
  to need attention there.
- Memory during ingest is dominated by the single `ts.Program`. Not profiled
  against a hard ceiling.

## Deferred by design (v1.1+)

- Second language beyond Java (Rust, Swift, Go, C/C++, JS, Python, SQL).
- `RETURNS_TYPE` / `PARAM_TYPE` edges.
- DOT output format.
- LSP-grade Java resolution (Eclipse JDT).
- The full evaluation task set. The harness itself is built (`eval/`, two
  conditions, rubric scoring, aggregate report, EV-6 honesty check); it ships
  with 5 seed tasks. The §9 corpus of 15 to 25 tasks on 2 to 3 open-source
  repos still needs to be written.
