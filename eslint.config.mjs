import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // La caratula de la pista es una `objectURL` de `blob:` creada con
    // `URL.createObjectURL` a partir de los bytes de la etiqueta del fichero. No hay
    // optimizador de imagen posible: `next/image` solo sabe descargar y redimensionar
    // rutas http, y para un blob habria que escribir un cargador a medida que acaba
    // haciendo lo mismo que un `<img>`. Ademas el elemento no va al servidor: es un
    // dato local del usuario, de unos cientos de kilobytes, y no es LCP.
    files: ["src/components/player/**"],
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
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
