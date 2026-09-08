# Limitations and known gaps

CodeGraph is a lead, not ground truth. This page is the honest list of what it
does not do yet, so you know when to still open the file.

## Resolution

- **Java call graph is syntactic.** Chained calls (`a.b().c()`), stream/lambda
  pipelines, and calls on cast or ternary expressions are `unresolved`, not
  edges. A Java `get_symbol_neighborhood` with few or no `CALLS` does not mean
  the method is unused - `meta.notes` says so on every Java result. See
  [languages.md](languages.md#java-call-resolution).
- **Cross-language edges are heuristic and literal-only.** A frontend
  `fetch` / `axios.*` / `apiRequest` call with a **string or template-literal**
  `/api/...` URL is matched to the Spring route with the same normalized
  method + path, and gets a `heuristic` `CALLS` edge to the route node. URLs
  built from variables or concatenation, a base-URL constant, or a non-`/api`
  prefix are missed. The match is method + path only, so two routes that differ
  only by content-type or headers are indistinguishable.
- **`REFERENCES` covers value and type positions, TypeScript only.** A use of an
  in-repo type as a type (`: Foo`, `Foo<T>`) is a `REFERENCES` edge; there is no
  distinction between "used as a return type" and "used as a param type". Java
  has no `REFERENCES` edges.
- **Function overloads collapse.** Two functions with the same qualified name
  produce one node (last wins).
- **`.d.ts` files are skipped.** Types declared only in ambient declarations are
  not nodes; imports resolving to them are unresolved.

## Routes

- **`@RequestMapping(method = {GET, POST})` arrays** take the first verb only.
- **React route unwrapping is heuristic.** `<Wrapper><Page/></Wrapper>` resolves
  to the last non-wrapper PascalCase tag, using a fixed wrapper list
  (`ProtectedRoute`, `Suspense`, `Layout`, ...). A custom wrapper not on that
  list, or `<Layout><Page/><Footer/></Layout>`, can pick the wrong component.
- **Nested route `children` path composition is not done.** Object config
  `{ path: "/x", children: [{ path: "y" }] }` records `/x` and `y`, not `/x/y`.

## Incremental update

- An unchanged caller's edge into a changed file keeps its **old resolution
  label** - it is not re-resolved.
- A removed file leaves unchanged importers with a **silently dropped edge** and
  no `unresolved` record.

Both are corrected by a full `codegraph ingest`. This is the deliberate
FR-INC-2 trade: a single-file refresh stays well under a second by not
reprocessing importers.

## Churn-weighted pruning

- Git churn (`file_churn`) is recorded only on a full `ingest`, never on
  `refresh`, so after many refreshes the pruning tie-break uses stale counts.
- It is file-level, not symbol-level: every symbol in a hot file is treated as
  hot. It only breaks ties between equally-distant nodes during truncation; it
  never hides a closer node.
- No git, or a repo root that is not the git root: no churn data, pruning falls
  back to distance only.

## Serving

- **`serve` runs one incremental update at startup**, then serves. Files that
  change while the server is running are not picked up unless the client calls
  the `refresh` tool (or you run `codegraph refresh --watch` separately).
- **`--watch` SIGINT cleanup on Windows** occasionally needs a second signal.

## Scale

- Performance is validated on a ~350-file / ~55k-LOC repo (~9 s cold ingest,
  ~6 ms median depth-2 query). It has not been profiled on a 500k-LOC
  monorepo; the recursive-CTE neighborhood query is the component most likely
  to need attention there.
- Memory during ingest is dominated by the single `ts.Program`. Not profiled
  against a hard ceiling.

## Module clustering

- The `skeleton` "areas" come from deterministic label propagation over the
  `IMPORTS` graph. It is a fast heuristic, not spectral/modularity-optimal
  clustering - a large hub module can pull unrelated areas together, and the
  cluster label is a path summary, not a semantic name.

## Deferred by design (v1.1+)

- Second language beyond Java (Rust, Swift, Go, C/C++, JS, Python, SQL).
- Distinct `RETURNS_TYPE` / `PARAM_TYPE` edges (type uses are `REFERENCES` now).
- DOT output format.
- LSP-grade Java resolution (Eclipse JDT).
- The full evaluation task set. The harness itself is built (`eval/`, two
  conditions, rubric scoring, aggregate report, EV-6 honesty check); it ships
  with 5 seed tasks. The §9 corpus of 15 to 25 tasks on 2 to 3 open-source
  repos still needs to be written.
