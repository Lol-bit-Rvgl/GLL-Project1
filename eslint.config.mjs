import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // `src-tauri/target` es la carpeta de compilacion de Rust: dentro, el script de
    // build de Tauri genera un `__global-api-script.js` que dispara un aviso de
    // eslint y no es codigo nuestro.
    "src-tauri/target/**",
  ]),
]);

export default eslintConfig;
