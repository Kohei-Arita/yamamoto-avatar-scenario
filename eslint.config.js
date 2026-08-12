import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["data/**/*.jsonl", "node_modules/**"]
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none"
        }
      ]
    }
  }
];
