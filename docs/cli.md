# CLI reference

```
codegraph [-C <path>] <command> [args]
```

`-C, --repo <path>` sets the repo root for every command. Each command also
takes an optional positional `[path]` that overrides it. Default is the current
directory.

In development, `npm run dev -- <command>` runs the same CLI through `tsx`.

---

## `ingest [path]`

Full build of the graph. Discovers every source file, parses it, resolves all
edges, and writes a fresh SQLite cache (any existing cache for this repo is
discarded first).

```
codegraph ingest .
codegraph ingest /path/to/repo
```

Output: `parsed 349/349 files - 2687 nodes - 5603 edges - 6132 unresolved - 0 errors - 8856ms`

A file that fails to parse is recorded in `parse_errors` and skipped; ingestion
never aborts.

---

## `refresh [path] [--watch]`

Incremental update. Re-parses only files whose content hash changed (or are
new), drops files that disappeared, and re-resolves edges for the affected
files. Much faster than `ingest` and non-destructive to unchanged data.

```
codegraph refresh .
```

Output: `+2 ~1 -0 - 2689 nodes - 5610 edges - 812ms`, or `nothing changed`.

`--watch` keeps the process running and re-refreshes on debounced filesystem
events. The TypeScript program is kept warm across updates. Status lines go to
stderr. `Ctrl-C` to stop.

```
codegraph refresh . --watch
```

See [architecture.md](architecture.md#incremental-update) for the trade-offs
(inbound edges from unchanged files keep their old resolution label; a full
`ingest` re-resolves everything).

---

## `stats [path]`

Node and edge counts by kind, resolution rate, unresolved breakdown, parse
errors, and ingest time.

```
codegraph stats .
```

```
nodes (2687)
 class      107
 method     1251
 ...
edges (5603)
 CALLS      1993
 IMPORTS    949
 ...
resolution
 resolved   5603
 unresolved 6132
   call     4488
   import   1599
calls (SC-3)
 resolved   1993
 rate       30.7%
```

The `calls` block is the call-edge resolution rate: `resolved / (resolved +
unresolved calls)`. It is dragged down by Java chained calls and by
unresolvable library calls; the TypeScript-only rate is much higher.

---

## `skeleton [path] [--json]`

The module graph: every `module` node, its `IMPORTS` edges, and its exported
symbol names. No bodies. Use it to orient in an unfamiliar repo.

```
codegraph skeleton .
codegraph skeleton . --json
```

---

## `find <query>`

Fuzzy symbol lookup. Accepts a bare name, `Class.method`, `path/to/file.ts:name`,
a qualified name, or a full node id.

```
codegraph -C /repo find apiRequest
codegraph -C /repo find DuesPaymentController.create
codegraph -C /repo find "Services/apiClient.ts:apiRequest"
```

Output is `score kind qualified_name file:line`, best first. Use it to turn a
name into an unambiguous target for `query`.

---

## `query neighborhood <symbol> [options]`

The egocentric subgraph around a symbol: its callers, callees, imports, and type
relations within N hops. Signatures and `file:line` only, never bodies.

```
codegraph -C /repo query neighborhood apiRequest --dir upstream
codegraph -C /repo query neighborhood handleSubmit --depth 2 --format json
```

| Option              | Default |                                                                        |
| ------------------- | ------- | ---------------------------------------------------------------------- |
| `--depth <n>`       | `2`     | hops from the seed, capped at 3                                        |
| `--dir <direction>` | `both`  | `upstream` (callers/importers), `downstream` (callees/imports), `both` |
| `--format <fmt>`    | `text`  | `text` or `json`                                                       |
| `--full`            | off     | emit every reachable node/edge with no token budget                    |

By default the result is fit to a token budget: it drops `REFERENCES` edges,
then reduces depth, then compacts detail (signatures dropped), and only as a
last resort omits the most distant neighbors. The output always reports
`neighbors: <shown> of <total>` and whether it was `truncated`. Pass `--full`
when you need the complete list regardless of size.

The `META` block at the end lists the seed's own unresolved references, the
resolution counts, and any caveats (for a Java seed: that call resolution is
syntactic).

---

## `query path <from> <to> [options]`

Shortest directed path from one symbol to another along `CALLS`, `HANDLES`, and
`IMPORTS` edges, or a report that none exists.

```
codegraph -C /repo query path App handleCheckout
codegraph -C /repo query path App handleCheckout --max 12 --format json
```

| Option           | Default |                  |
| ---------------- | ------- | ---------------- |
| `--max <n>`      | `8`     | maximum hops     |
| `--format <fmt>` | `text`  | `text` or `json` |

Directed: it follows edge direction. `path(handler, dbLayer)` walks the call
chain forward; the reverse is a separate query.

---

## `serve`

Start the MCP stdio server for the repo (`-C` or cwd). If the cache is cold it
ingests first, reporting progress on stderr. See [mcp.md](mcp.md).

```
codegraph -C /path/to/repo serve
```
