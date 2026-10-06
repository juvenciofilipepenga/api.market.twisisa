import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";

export default [
  { ignores: ["node_modules/**", "dist/**", "src/generated/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser, parserOptions: { ecmaVersion: "latest", sourceType: "module" } },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }]
    }
  }
];
