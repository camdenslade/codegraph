# Architecture

## Pipeline

```
repo root
   |
   v
per-language discovery            LanguageAnalyzer.discoverFiles()
   |                              TS: tsconfig include/exclude + .gitignore
   |                              Java: source-tree walk + .gitignore
   v
parse                             LanguageAnalyzer.parseFile()
   |                              -> symbols (nodes) + raw imports
   v
persist nodes                     persistUnits()
   |                              files row, module node, symbol nodes, DECLARES
   v
build cross-file index            buildNodeIndex()   (every language's nodes)
   |
   v
resolve edges                     LanguageAnalyzer.resolveEdges()
   |                              IMPORTS, CALLS, REFERENCES, EXTENDS,
   |                              IMPLEMENTS, HANDLES + unresolved rows
   v
persist edges + routes + unresolved
   |
   +--> CLI query layer (recursive CTEs over SQLite)
   +--> MCP stdio server -> Claude Code / Claude Desktop
```

Ingestion runs in two phases across all registered analyzers:

1. **Phase 1** discovers, parses, and persists nodes for every language. Nothing
   resolves yet.
2. **Phase 2** builds one `NodeIndex` over the whole graph (so a TS file and a
   Java file can both see every node), then each analyzer resolves its edges.

This ordering means cross-file and (in principle) cross-language resolution can
see the complete node set before any edge is drawn.

## `LanguageAnalyzer`

Every language is a `LanguageAnalyzer` (`src/lang/types.ts`). Core never
imports a language module directly; it iterates `ANALYZERS`
(`src/lang/registry.ts`).

```ts
interface LanguageAnalyzer {
	id: string; // "typescript" | "java"
	extensions: string[]; // [".ts", ".tsx"]
	discoverFiles(repoRoot): Discovered;
	parseFile(relPath, absPath, source): ParsedUnit; // symbols + imports
	resolveEdges(input: ResolveInput): ResolveOutput; // edges + unresolved + routes
}
```

`ResolveInput` carries a `NodeIndex` (`ids`, `has(id)`, `idsByName`,
`typeIdsByName`, `idByQualifiedName`) built by core from SQLite, plus an
opaque `carry` slot an analyzer can use to hand heavy state (a warm
`ts.Program`) to its next run. `Discovered.options` and `ParsedUnit.meta` are
opaque `unknown` slots for analyzer-private data (TS `CompilerOptions`, the
Java package name and parse tree).

Adding a language is: implement the three methods, add the object to
`ANALYZERS`. Core does not change. See
[languages.md](languages.md).

### TypeScript analyzer

`src/lang/typescript/`. `discoverFiles` and `parseFile` wrap the existing
tree-sitter structural pass and import extractor. `resolveEdges` builds one
`ts.Program` over every discovered file (so the checker resolves cross-file
types and re-export barrels), walks only the units being (re)resolved, and runs
the semantic pass + route extractors. The `ts.Program` is returned as `carry`
so `--watch` reuses it.

### Java analyzer

`src/lang/java/`. tree-sitter (`tree-sitter-java`). `parseFile` extracts
classes/interfaces/enums/records and their methods, and `import` statements,
and stashes the parse tree in `meta` so `resolveEdges` does not re-parse.
`resolveEdges` does:

- **IMPORTS**: `import com.x.Foo` to a file whose path ends `com/x/Foo.java`.
- **EXTENDS/IMPLEMENTS**: the supertype's simple name resolved via an explicit
  import, then the same package, then a unique type name across the graph.
  Generic arguments are ignored (`JpaRepository<Foo>` extends `JpaRepository`).
- **CALLS** (`src/lang/java/calls.ts`): a syntactic walk with a per-scope type
  environment (fields, params, locals). Resolves same-class calls, `this.f.m()`
  / `f.m()` via the field's declared type, `local.m()` via the local's type,
  `Type.staticM()`, `super.m()`, and `new Type()`. No return-type inference, so
  chained calls are `unresolved`.

## Storage

One SQLite file per repo, in an OS cache dir keyed by the repo's canonical
absolute path (`dbPathForRepo` in `src/store/db.ts`). Never inside the repo.
The Windows drive-letter case is normalized so `ingest c:/x` and a query run
from `C:\x` hit the same cache.

Schema (`src/store/schema.ts`, `SCHEMA_VERSION` currently 3):

```sql
meta(key, value)
files(path, hash, mtime, parsed_at)
nodes(id, kind, name, qualified_name, file, span_start, span_end, signature, doc, exported)
edges(src, dst, kind, resolution, file, line)          PRIMARY KEY (src, dst, kind)
unresolved(id, node_id, kind, text, file, line)
parse_errors(file, message, at)
```

- Node `id` is deterministic: `kind:qualified_name`, where `qualified_name` is
  `relPath:name` (or `relPath:Container.name` for members). Re-ingesting
  produces byte-identical rows.
- `nodes.file` has `ON DELETE CASCADE` back to `files`, and `edges` /
  `unresolved` cascade from `nodes`. The connection sets
  `PRAGMA foreign_keys = ON`; deleting a `files` row clears everything that
  file owns.
- A schema-version mismatch deletes the cache and rebuilds. The cache is
  disposable by design.

Neighborhood queries are recursive CTEs over `edges` (`src/query/neighborhood.ts`).
`find_path` is a BFS over an in-memory adjacency map of `CALLS`/`HANDLES`/`IMPORTS`.

## Incremental update

`src/ingest/incremental.ts`. On `refresh`:

1. Discover the current file set, hash each file, diff against `files.hash`:
   `added`, `changed`, `removed`, `unchanged`.
2. **Snapshot** inbound edges whose target is in the reparse set but whose
   source is not (so `A -> X` survives when only `X` changes and `A` is not
   reprocessed).
3. Delete `removed` files (cascade). Reparse `added` + `changed`
   (`persistUnits` deletes each file's old nodes first, cascading its old
   edges and unresolved rows away).
4. Re-resolve edges for the reparsed units only (the analyzer still builds a
   Program over the full file set for the checker's benefit).
5. **Restore** the snapshotted inbound edges whose endpoints both still exist.
6. Recompute `input_set_hash`.

**Known limitation**: an unchanged caller's edge into a changed file keeps its
old `resolution` label (it is not re-resolved), and a removed file leaves
unchanged importers with a silently dropped edge and no `unresolved` record. A
full `ingest` fixes both. This is the FR-INC-2 trade documented in the
requirements.

`--watch` (`src/ingest/watch.ts`) runs the incremental update on debounced
`chokidar` events and carries the warm `ts.Program` across runs. Status goes to
stderr so stdout stays clean if the process shares a pipe.

## Determinism

Same inputs produce byte-identical graph dumps (`dumpGraph`,
`src/query/dump.ts`), which the golden tests assert. Node ids are
deterministic, files are processed in sorted order, and `input_set_hash` is a
hash of the sorted `(path, contentHash)` set. The incremental test asserts an
incremental update produces the same dump as a full rebuild of the same state.
