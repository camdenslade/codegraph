import { sep } from "node:path";
import chokidar from "chokidar";
import type ts from "typescript";
import { discoverFiles } from "./discover.js";
import { incrementalUpdate } from "./incremental.js";

/**
 * Prime the graph, then keep it fresh: on any .ts/.tsx add/change/unlink, run a
 * debounced incremental update. The TS Program is kept warm across updates
 * (`previousProgram`) so rebuilds stay well inside the FR-INC-3 budget.
 * Status goes to stderr; stdout is left clean in case this shares a pipe.
 */
export async function watchRepo(repoRoot: string): Promise<void> {
	const { repoRoot: root } = discoverFiles(repoRoot);

	let warm: ts.Program | undefined;
	const first = incrementalUpdate(root);
	warm = first.program ?? warm;
	log(
		`watching ${root} — ${first.report.nodeCount} nodes, ` +
			`${first.report.edgeCount} edges`,
	);

	let timer: NodeJS.Timeout | undefined;
	let pending = false;
	let running = false;

	const trigger = (): void => {
		pending = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void run(), 300);
	};

	const run = async (): Promise<void> => {
		if (running) return; // a run is in flight; `pending` will re-trigger it
		pending = false;
		running = true;
		try {
			const t0 = Date.now();
			const { report, program } = incrementalUpdate(root, {
				previousProgram: warm,
			});
			warm = program ?? warm;
			if (!report.noop) {
				log(
					`+${report.added.length} ~${report.changed.length} ` +
						`-${report.removed.length} · ${report.nodeCount}n ` +
						`${report.edgeCount}e · ${Date.now() - t0}ms`,
				);
			}
		} catch (err) {
			log(`refresh failed: ${(err as Error).message}`);
		} finally {
			running = false;
			if (pending) trigger();
		}
	};

	const watcher = chokidar.watch(root, {
		ignoreInitial: true,
		ignored: (p: string) =>
			p.includes(`${sep}node_modules${sep}`) ||
			p.includes(`${sep}dist${sep}`) ||
			p.includes(`${sep}.git${sep}`),
		awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
	});
	watcher.on("all", (_event, p: string) => {
		if (p.endsWith(".ts") || p.endsWith(".tsx")) trigger();
	});

	await new Promise<void>((resolve) => {
		process.on("SIGINT", () => {
			log("stopping");
			void watcher.close().then(resolve);
		});
	});
}

function log(msg: string): void {
	process.stderr.write(`[codegraph:watch] ${msg}\n`);
}
