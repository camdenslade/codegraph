import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["dist/", "node_modules/", "test/fixtures/", "eval/repos/"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			// The codebase uses `as` casts against better-sqlite3's `unknown` rows
			// and tree-sitter's loose types; those are deliberate and checked by
			// the surrounding SQL/grammar knowledge.
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			// Fights the normal "seed a value, maybe reassign in a loop" pattern.
			"no-useless-assignment": "off",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
);
