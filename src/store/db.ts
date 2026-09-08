import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export type DB = Database.Database;

/** OS-appropriate cache root. */
export function cacheRoot(): string {
	const override = process.env.CODEGRAPH_CACHE_DIR;
	if (override) return override;
	const home = homedir();
	switch (platform()) {
		case "win32":
			return join(
				process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
				"codegraph",
			);
		case "darwin":
			return join(home, "Library", "Caches", "codegraph");
		default:
			return join(
				process.env.XDG_CACHE_HOME ?? join(home, ".cache"),
				"codegraph",
			);
	}
}

/** Canonical absolute path. Normalizes Windows drive-letter case so the same
 * repo always maps to the same cache no matter how the path was typed. */
export function canonicalRoot(repoRoot: string): string {
	let abs = resolve(repoRoot);
	if (process.platform === "win32" && /^[a-z]:/.test(abs)) {
		abs = abs[0]!.toUpperCase() + abs.slice(1);
	}
	return abs;
}

/** Cache file for a repo, keyed by its absolute path. */
export function dbPathForRepo(repoRoot: string): string {
	const abs = canonicalRoot(repoRoot);
	const hash = createHash("sha256").update(abs).digest("hex").slice(0, 12);
	const dir = join(cacheRoot(), `${basename(abs)}-${hash}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "graph.sqlite");
}

export interface OpenOptions {
	/** Delete any existing db and start fresh */
	fresh?: boolean;
}

export function openDB(repoRoot: string, opts: OpenOptions = {}): DB {
	const path = dbPathForRepo(repoRoot);
	if (opts.fresh) removeDbFiles(path);

	let db = openConn(path);

	/** Check the stored schema version on a bare connection, before applying
    SCHEMA_SQL: a stale schema may lack columns the new schema indexes. */
	const version = readSchemaVersion(db);
	if (version !== null && version !== SCHEMA_VERSION) {
		db.close();
		removeDbFiles(path);
		db = openConn(path);
	}

	db.exec(SCHEMA_SQL); // safe: file is fresh, or already at the current version
	writeSchemaVersion(db);
	return db;
}

function openConn(path: string): DB {
	const db = new Database(path);
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("foreign_keys = ON");
	return db;
}

function readSchemaVersion(db: DB): number | null {
	try {
		const row = db
			.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
			.get() as { value: string } | undefined;
		return row ? Number(row.value) : null;
	} catch {
		return null; // meta table doesn't exist yet (brand-new file)
	}
}

function writeSchemaVersion(db: DB): void {
	db.prepare(
		"INSERT INTO meta(key, value) VALUES('schema_version', ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(SCHEMA_VERSION.toString());
}

function removeDbFiles(path: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		rmSync(path + suffix, { force: true });
	}
}
