# CLAUDE.md

Guidance for AI agents working in this repo.

## What this is

CodeGraph parses a codebase into a SQLite graph of symbols and relationships and
serves egocentric slices of it over MCP. Read `README.md`, then
`docs/architecture.md`.

## Before you commit

```bash
npm run check     # tsc --noEmit && eslint && vitest run  -- must pass
```

If you changed anything that affects `dumpGraph()` output, update the golden
snapshot and review the diff:

```bash
npx vitest run -u
```

## Conventions

- Prettier: tabs, 4-wide, 80 cols. `npm run format`.
- Comments: plain `//`, sentence case, no ASCII dividers, no em-dashes.
- ESM with `NodeNext`: relative imports use a `.js` extension (`./db.js` even
  for `db.ts`).
- `better-sqlite3` is synchronous. Rows come back typed `unknown`; the `as`
  casts on `.get()` / `.all()` are deliberate.
- Never write inside a target repo. The graph cache lives in an OS cache dir
  (`src/store/db.ts`).

## Where things are

- Pipeline core, language-agnostic: `src/ingest/`, `src/store/`, `src/query/`.
- Languages: `src/lang/` - `types.ts` is the `LanguageAnalyzer` interface,
  `registry.ts` lists them, `typescript/` and `java/` implement them. Core
  never imports a language module directly.
- MCP: `src/mcp/server.ts` (tool schemas) + `src/mcp/tools.ts` (adapters).
- CLI: `src/cli.ts`.

## Adding a language

Implement `LanguageAnalyzer` in `src/lang/<lang>/`, add it to `ANALYZERS`, add a
fixture under `test/fixtures/` and a test. Do not modify core. Details in
`docs/languages.md`.

## Schema changes

Bump `SCHEMA_VERSION` in `src/store/schema.ts`. No migrations - a version
mismatch drops and rebuilds the cache.

## Known limitations

`docs/limitations.md`. In particular: Java call resolution is syntactic (no
chained calls), there are no cross-language edges, and incremental update does
not re-resolve edges from unchanged importers.
