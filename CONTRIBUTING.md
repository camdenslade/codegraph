# Contributing

## Setup

```bash
npm install
npm run check     # tsc --noEmit && eslint && vitest run
```

Node 20+. `npm install` fetches prebuilt native binaries for `better-sqlite3`
and the tree-sitter grammars; no compiler toolchain is required.

## Scripts

|                         |                                              |
| ----------------------- | -------------------------------------------- |
| `npm run dev -- <args>` | run the CLI through `tsx` without building   |
| `npm run build`         | `tsc` to `dist/`                             |
| `npm test`              | `vitest run`                                 |
| `npm run test:watch`    | vitest in watch mode                         |
| `npm run check`         | typecheck + lint + test, the pre-commit gate |
| `npm run format`        | `prettier --write .`                         |

## Style

- Prettier with tabs, 4-wide, 80 columns (`.prettierrc.json`). Run
  `npm run format` before committing.
- Plain `//` comments, sentence case. No ASCII-art dividers.
- ESLint flat config (`eslint.config.js`). `any` and non-null assertions are
  allowed where they are load-bearing against `better-sqlite3`'s `unknown` rows
  and tree-sitter's loose types.

## Tests

`vitest`, under `test/`. Two kinds:

- **Golden snapshots** - `dumpGraph()` of a fixture repo is snapshotted
  (`test/__snapshots__/`). Run `npx vitest run -u` to update after an
  intentional change, and review the diff.
- **Equivalence** - `test/incremental.test.ts` asserts an incremental update
  produces the same `dumpGraph()` as a full rebuild of the same file state.

Fixtures live in `test/fixtures/<name>/` and are copied to a temp dir per test
run. `CODEGRAPH_CACHE_DIR` is redirected to a temp dir in `beforeAll` so tests
never touch the real cache.

## Repo layout

```
src/
  cli.ts              commander entrypoint
  ingest/             the pipeline core (language-agnostic)
    index.ts          full ingest orchestration
    incremental.ts    hash-diff incremental update
    watch.ts          --watch mode
    node-index.ts     builds the cross-file NodeIndex from SQLite
    discover.ts       TS file discovery (tsconfig + .gitignore)
    structural.ts     TS tree-sitter node extraction
    imports.ts        TS import-statement extraction
    semantic.ts       TS compiler-API edge resolution
    program.ts        shared ts.Program builder
    passes.ts         TS import/route pass helpers
    routes/           pluggable route extractors (express, react-router)
  lang/
    types.ts          the LanguageAnalyzer interface
    registry.ts       ANALYZERS list
    typescript/       wraps ingest/* as a LanguageAnalyzer
    java/             tree-sitter-java analyzer + calls.ts
  store/
    schema.ts         SQLite schema + SCHEMA_VERSION
    db.ts             cache location, connection, pragmas
    persist.ts        node/edge/unresolved writers
  query/
    neighborhood.ts   recursive-CTE egocentric subgraph
    path.ts           BFS shortest path
    skeleton.ts       module graph
    find-symbol.ts    fuzzy lookup
    serialize.ts      token-budgeted rendering + degradation ladder
    stats.ts / dump.ts
  mcp/
    server.ts         MCP stdio server, tool schemas
    tools.ts          tool adapters over the query layer
```

## Adding a language

See [docs/languages.md](docs/languages.md#adding-a-language). Short version:
implement `LanguageAnalyzer`'s three methods in `src/lang/<lang>/`, add the
object to `ANALYZERS`, add a fixture + test. Core does not change.

## Schema changes

Bump `SCHEMA_VERSION` in `src/store/schema.ts` for any schema change. A version
mismatch deletes the cache and rebuilds; there are no migrations (the cache is
disposable).

## Commits

`npm run check` must pass. Keep the golden snapshots in sync (`vitest run -u`
and review). Do not commit `dist/` (gitignored).
