declare module "tree-sitter-typescript" {
	const bindings: { typescript: unknown; tsx: unknown };
	export default bindings;
}

declare module "tree-sitter-java" {
	const language: unknown;
	export = language;
}
