# Language support

## Capability matrix

| Capability                           | TypeScript / TSX                                                                                                                   | Java                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| File discovery                       | tsconfig `include` / `exclude`, `.gitignore`                                                                                       | recursive walk of `.java`, skipping build dirs (`target`, `build`, `out`, `bin`, `.gradle`, ...), `.gitignore` |
| `module` node per file               | yes                                                                                                                                | yes                                                                                                            |
| `function` nodes                     | yes                                                                                                                                | n/a                                                                                                            |
| `class` / `interface` / `enum` nodes | yes                                                                                                                                | yes                                                                                                            |
| `record` nodes                       | n/a                                                                                                                                | yes                                                                                                            |
| `type-alias` nodes                   | yes                                                                                                                                | n/a                                                                                                            |
| `variable` nodes                     | exported top-level only                                                                                                            | no (fields not indexed)                                                                                        |
| `method` nodes                       | yes                                                                                                                                | yes (constructors stored as `<init>`)                                                                          |
| Nested types                         | yes                                                                                                                                | yes (`Outer.Nested`)                                                                                           |
| Doc comments                         | leading `/** */`                                                                                                                   | leading `/** */` (Javadoc)                                                                                     |
| `IMPORTS`                            | tsconfig paths, `index` resolution, re-export barrels, `node_modules` excluded                                                     | `import com.x.Foo` to `.../com/x/Foo.java`; `import com.x.*` and third-party recorded as unresolved            |
| `DECLARES`                           | yes                                                                                                                                | yes                                                                                                            |
| `CALLS`                              | TypeScript compiler API: overloads, aliases, re-exports; `any`-typed and dynamic calls fall back to a name heuristic or unresolved | syntactic (see below)                                                                                          |
| `REFERENCES`                         | value-position uses of a tracked symbol                                                                                            | not extracted                                                                                                  |
| `EXTENDS` / `IMPLEMENTS`             | compiler API                                                                                                                       | simple-name resolution: explicit import, then same package, then unique type name; generic args ignored        |
| Routes (`route` nodes, `HANDLES`)    | Express / Fastify (`x.get("/p", h)`, `x.route({...})`), React Router (`<Route path element/component>`)                            | not yet (Spring `@GetMapping` is planned)                                                                      |
| Warm-rebuild state for `--watch`     | reuses the `ts.Program`                                                                                                            | none needed                                                                                                    |

## TypeScript call resolution

`get_symbol_neighborhood` on a TS symbol is backed by
`checker.getResolvedSignature` and `checker.getSymbolAtLocation`, with alias
(import / re-export) following. A call resolves to a `CALLS` edge when it binds
to a function or method the graph tracks. A call the checker binds to a `.d.ts`
declaration is treated as external and ignored (not reported as unresolved). A
call the checker cannot bind at all is either matched to a unique same-named
graph symbol (`heuristic`) or recorded in `unresolved`.

Measured call-edge resolution on plain TypeScript is high (mid-to-high 70s
percent and up); the misses are mostly library method calls (`arr.map`,
`.replace`) that carry no useful graph target anyway.

## Java call resolution

`src/lang/java/calls.ts`. A single AST walk maintains a per-scope type
environment:

- **fields** - `private FooService svc;` adds `svc -> FooService`.
- **parameters** - `void handle(Bar b)` adds `b -> Bar`.
- **locals** - `Baz x = ...;` adds `x -> Baz` (all locals in the method body
  are collected up front; shadowing and declaration order are ignored).

Resolution of `obj.method(...)`:

| Form                                           | Resolves to                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `method(...)` (no receiver)                    | a method of the enclosing class; else a method of the resolved superclass; else a unique same-named method (`heuristic`) |
| `this.method(...)`                             | a method of the enclosing class                                                                                          |
| `super.method(...)`                            | a method of the resolved superclass                                                                                      |
| `field.method(...)` / `this.field.method(...)` | a method of `field`'s declared type                                                                                      |
| `local.method(...)`                            | a method of `local`'s declared type                                                                                      |
| `Type.method(...)` (capitalized receiver)      | a static method of `Type`                                                                                                |
| `new Type(...)`                                | `Type.<init>`, or the `Type` class node                                                                                  |

**Not resolved** (recorded as `unresolved` with kind `call`):

- chained calls: `repo.findById(id).orElseThrow()` - the `.orElseThrow()` has no
  known receiver type.
- stream / lambda pipelines: `list.stream().map(...).collect(...)`.
- calls on expressions: `(cond ? a : b).m()`, casts, array elements.
- anything whose receiver type is a third-party class.

This is intentional. Without a real type resolver (javac / Eclipse JDT), return
types are unknown, so anything past the first `.` is a guess. The graph reports
these rather than inventing edges, and every Java neighborhood result carries a
`meta.notes` line saying so.

Java `EXTENDS` / `IMPLEMENTS` uses the same simple-name resolver as calls.
Repos that extend framework base types (`JpaRepository`, `OncePerRequestFilter`)
correctly leave those as unresolved `heritage`.

## Adding a language

1. `src/lang/<lang>/index.ts` exporting a `LanguageAnalyzer`:
    - `discoverFiles(repoRoot)` - return absolute file paths. Honor `.gitignore`;
      skip build output.
    - `parseFile(relPath, absPath, source)` - return `symbols` (`LangSymbol[]`)
      and `imports` (`LangImport[]`). Use `tree-sitter-<lang>`. Stash anything
      `resolveEdges` needs in `meta`.
    - `resolveEdges(input)` - return `edges` (`EdgeRow[]`), `unresolved`
      (`UnresolvedRow[]`), and `routeNodes`. `input.index` is the whole graph's
      node set; `input.allRelPaths` is every current file for your language.
2. Add the object to `ANALYZERS` in `src/lang/registry.ts`.
3. Add a fixture repo under `test/fixtures/<lang>-app/` and a test that ingests
   it and asserts on `dumpGraph`.

Core (`src/ingest/`, `src/store/`, `src/query/`, `src/mcp/`) does not change. An
import-graph-level analyzer (discovery + nodes + `IMPORTS` + `EXTENDS`) is a
few hundred lines and mostly tree-sitter node-walking; a real call graph needs
per-language type resolution and is the hard part.

Planned order: Rust, Swift, Go, C / C++, JavaScript, Python, SQL.
