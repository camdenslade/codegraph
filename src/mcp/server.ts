import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
	toolFindPath,
	toolFindSymbol,
	toolNeighborhood,
	toolRefresh,
	toolSkeleton,
	type ToolResult,
} from "./tools.js";

const FORMAT_PROP = {
	type: "string",
	enum: ["json", "text"],
	default: "json",
	description: "json for programmatic use, text for a compact outline",
};

const TOOLS = [
	{
		name: "get_symbol_neighborhood",
		description:
			"Callers, callees, imports and type relations around a symbol, within N hops. " +
			"Signatures and file:line only, never bodies. Treat it as a lead, not ground " +
			"truth - check meta.truncated and meta.unresolved_in_scope before concluding.",
		inputSchema: {
			type: "object",
			properties: {
				symbol: {
					type: "string",
					description:
						"bare name, file.ts:name, or qualified name; run find_symbol first if unsure",
				},
				depth: { type: "integer", minimum: 1, maximum: 3, default: 2 },
				direction: {
					type: "string",
					enum: ["upstream", "downstream", "both"],
					default: "both",
				},
				format: FORMAT_PROP,
			},
			required: ["symbol"],
		},
	},
	{
		name: "find_path",
		description:
			"Shortest directed path from one symbol to another along CALLS/HANDLES/IMPORTS, " +
			"or a report that none exists within max_len.",
		inputSchema: {
			type: "object",
			properties: {
				from_symbol: { type: "string" },
				to_symbol: { type: "string" },
				max_len: {
					type: "integer",
					minimum: 1,
					maximum: 16,
					default: 8,
				},
				format: FORMAT_PROP,
			},
			required: ["from_symbol", "to_symbol"],
		},
	},
	{
		name: "get_architectural_skeleton",
		description:
			"The module graph (files + import edges) plus each module's exported symbol names. " +
			"No bodies. Use to orient in an unfamiliar codebase.",
		inputSchema: { type: "object", properties: { format: FORMAT_PROP } },
	},
	{
		name: "find_symbol",
		description:
			"Fuzzy symbol lookup returning candidates with kind and location. Call this first " +
			"to turn a bare name into an unambiguous target for the other tools.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" }, format: FORMAT_PROP },
			required: ["query"],
		},
	},
	{
		name: "refresh",
		description: "Re-scan the repo and rebuild the graph.",
		inputSchema: { type: "object", properties: {} },
	},
];

export async function runServer(repoRoot: string): Promise<void> {
	const server = new Server(
		{ name: "codegraph", version: "0.0.1" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOLS as Tool[],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args = {} } = req.params;
		try {
			const result = dispatch(
				repoRoot,
				name,
				args as Record<string, unknown>,
			);
			// Neighborhood text already carries a META block; others don't.
			const footer = result.text.includes("\nMETA")
				? ""
				: `\n\n---\nmeta: ${result.meta.resolution_summary.resolved} resolved, ` +
					`${result.meta.resolution_summary.heuristic} heuristic; ` +
					`${result.meta.unresolved_in_scope.length} unresolved in scope; ` +
					`truncated: ${result.meta.truncation_reason ?? "no"}`;
			return {
				content: [{ type: "text", text: result.text + footer }],
			};
		} catch (err) {
			return {
				content: [
					{ type: "text", text: `error: ${(err as Error).message}` },
				],
				isError: true,
			};
		}
	});

	await server.connect(new StdioServerTransport());
}

function dispatch(
	repoRoot: string,
	name: string,
	args: Record<string, unknown>,
): ToolResult {
	switch (name) {
		case "get_symbol_neighborhood":
			return toolNeighborhood(repoRoot, args as never);
		case "find_path":
			return toolFindPath(repoRoot, args as never);
		case "get_architectural_skeleton":
			return toolSkeleton(repoRoot, args as never);
		case "find_symbol":
			return toolFindSymbol(repoRoot, args as never);
		case "refresh":
			return toolRefresh(repoRoot);
		default:
			throw new Error(`unknown tool: ${name}`);
	}
}
