// Comprobacion de que los tests estructurales SABEN FALLAR.
//
// Un test que solo pasa no prueba nada: lo que importa es que detects el codigo roto.
// Este script parte de una copia de `src/` en un temporal, aplica cada una de las
// regresiones que ya ocurrieron, ejecuta `estructural.mjs` contra la copia rota y exige
// que FALLE. Si alguna mutacion pasa el test, ese test no estaba vigilando lo que
// dice vigilar y hay que arreglarlo antes de confiar en el.
//
// Uso: `node pruebas/mutacion.mjs`

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ESTRUCTURAL = path.join(RAIZ, "pruebas", "estructural.mjs");

// Cada mutacion devuelve el texto roto a partir del original. Se escribe en el estilo
// que existed ANTES del arreglo, no en uno inventado aqui: si el test no detecta la
// forma real del bug, es que el test mira el sitio equivocado.
const MUTACIONES = [
  {
    nombre: "el bug del indice: .map(vuBarScale) sin envolver",
    fichero: "src/components/VuMeter.tsx",
    rompe: (t) => t.replace("vuEnvelope(level.history).map((value) => vuBarScale(value))", "vuEnvelope(level.history).map(vuBarScale)"),
  },
  {
    nombre: "el arreglo equivocado: quitar el parametro floor de vuBarScale",
    fichero: "src/lib/vu.ts",
    rompe: (t) =>
      t.replace(
        /export function vuBarScale\(value: number, floor: number = FLOOR\)/,
        "export function vuBarScale(value: number)",
      ),
  },
  {
    nombre: "la fila con la longitud del historial en vez de 48 fijas",
    fichero: "src/components/VuMeter.tsx",
    rompe: (t) =>
      t.replace(
        /const scales = useMemo\(\(\) => \{[\s\S]*?\}, \[active, level\.history\]\);/,
        "const scales = useMemo(() => vuEnvelope(level.history).map((value) => vuBarScale(value)), [active, level.history]);",
      ),
  },
  {
    nombre: "el grupo sin min-w: la pista se ajusta a su contenido",
    fichero: "src/components/VuMeter.tsx",
    rompe: (t) => t.replace("flex min-w-[300px] max-w-[420px] flex-1 items-center gap-3", "flex items-center gap-3"),
  },
  {
    nombre: "un min-w insuficiente: 120 px reparte 120 entre 48 barras",
    fichero: "src/components/VuMeter.tsx",
    rompe: (t) => t.replace("min-w-[300px]", "min-w-[120px]"),
  },
  {
    nombre: "las barras sin flex-1: no reparten el ancho de la pista",
    fichero: "src/components/VuMeter.tsx",
    rompe: (t) => t.replace("vu-bar min-w-0 flex-1", "vu-bar min-w-0"),
  },
  {
    nombre: "la pista sin flex-1: el min-w del grupo no le llega",
    fichero: "src/components/VuMeter.tsx",
    rompe: (t) => t.replace("className=\"flex h-6 flex-1 items-end", "className=\"flex h-6 items-end"),
  },
  {
    nombre: "el timestamp con opacidad al 60 %, por debajo de 4.5:1",
    fichero: "src/components/TranscriptStream.tsx",
    rompe: (t) => t.replace(/(className="[^"]*)\btext-flare\b([^"]*")/, "$1text-flare/60$2"),
  },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lyricstream-mutacion-"));
let supervivientes = 0;

try {
  // Copia `src/` una vez: cada mutacion parte de la copia intacta.
  fs.cpSync(path.join(RAIZ, "src"), path.join(tmp, "src"), { recursive: true });

  for (const m of MUTACIONES) {
    const destino = path.join(tmp, m.fichero);
    const original = fs.readFileSync(path.join(RAIZ, m.fichero), "utf8");
    const roto = m.rompe(original);
    if (roto === original) {
      console.log("  AVISO " + m.nombre);
      console.log("         la mutacion no cambio nada: el codigo ya no tiene esa forma y el test");
      console.log("         esta comprobando un texto que no existe. Actualiza la mutacion.");
      supervivientes += 1;
      continue;
    }
    fs.writeFileSync(destino, roto, "utf8");

    const res = spawnSync(process.execPath, [ESTRUCTURAL, tmp], { encoding: "utf8" });
    if (res.status === 0) {
      supervivientes += 1;
      console.log("  PASA   " + m.nombre + "  <-- el test NO la detecta");
    } else {
      const linea = (res.stdout || "")
        .split("\n")
        .find((l) => l.includes("FALLA") || l.trim().startsWith("en "));
      console.log("  detecta " + m.nombre);
      if (linea) console.log("         " + linea.trim());
    }
    // Se restaura para que la siguiente mutacion parta del codigo bueno.
    fs.writeFileSync(destino, original, "utf8");
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (supervivientes > 0) {
  console.log("\n" + supervivientes + " mutaciones de " + MUTACIONES.length + " NO las detecta ningun test");
  process.exit(1);
}
console.log("\nlas " + MUTACIONES.length + " regresiones se detectan");
