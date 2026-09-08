/**
 *  The full database schema for the CodeGraph database.
 *  This is used to create the database and to validate the data in the database.
 *  Bump SCHEMA_VERSION on any change; a mismatch triggers a full rebuild.
 */
export const SCHEMA_VERSION = 4;

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per source file.
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    parsed_at INTEGER NOT NULL
);

-- Git activity per file, for heat-weighted context pruning. Not part of the
-- deterministic graph dump - it depends on history and is refreshed only on a
-- full ingest.
CREATE TABLE IF NOT EXISTS file_churn (
    path        TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
    commits     INTEGER NOT NULL,
    last_commit INTEGER
);

-- Nodes are unique by their name and the file they are defined in.
CREATE TABLE IF NOT EXISTS nodes (
    id Text PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    signature TEXT,
    doc TEXT,
    exported INTEGER NOT NULL DEFAULT 0
);

-- Static relationships between nodes.
CREATE TABLE IF NOT EXISTS edges (
    src TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    dst TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    resolution TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    PRIMARY KEY (src, dst, kind)
);

-- Call/reference targets we didn't bind to node.
CREATE TABLE IF NOT EXISTS unresolved (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'call',
    text TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL
);

-- Files skipped due to parse failures or other errors.
CREATE TABLE IF NOT EXISTS parse_errors (
    file TEXT NOT NULL,
    message TEXT NOT NULL,
    at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_unresolved_node_id ON unresolved(node_id);
CREATE INDEX IF NOT EXISTS idx_nodes_exported ON nodes(exported);
`;
