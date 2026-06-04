import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    // Build output and dependencies — never lint generated/minified code.
    ignores: [
      ".next/**",
      "out/**",
      "node_modules/**",
      "api/dist/**",
      "api/node_modules/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Root-level CommonJS Node scripts (dev CORS proxy / config) legitimately
    // use require() and module.exports — the TS no-require rule doesn't apply.
    files: ["*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default eslintConfig;
