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
  {
    // La forma en que se rompe: cambiar el indicador a `left` porque "se ve igual".
    // Solo se ve mal al cambiar de fuente, que es cuando el `left` se anima.
    nombre: "el conmutador animando `left` en vez de `transform`",
    fichero: "src/components/ControlBar.tsx",
    rompe: (t) =>
      t.replace("transition-transform duration-200 ease-out", "transition-[left] duration-200 ease-out"),
  },
  {
    // El mismo fallo colado por la puerta de atras: `transition-all` deja pasar `left`
    // sin que la comprobacion de la transicion lo note.
    nombre: "el conmutador con `transition-all`, que deja pasar `left`",
    fichero: "src/components/ControlBar.tsx",
    rompe: (t) =>
      t.replace("transition-transform duration-200 ease-out", "transition-all duration-200 ease-out"),
  },
  {
    // Quitar el `motion-safe:` es la forma natural de "simplificar" la clase.
    nombre: "la entrada del bloque sin `motion-safe`, fuera del alcance de reduced-motion",
    fichero: "src/components/TranscriptStream.tsx",
    rompe: (t) => t.replaceAll("motion-safe:animate-[slide-up-fade_", "animate-[slide-up-fade_"),
  },
  {
    // La reescritura "obvia" del contador: un efecto que cuenta. Pinta el historial
    // entero una vez mas por frase y rompe las reglas del React Compiler.
    nombre: "el contador de frases sin leer contado en un useEffect",
    fichero: "src/components/TranscriptStream.tsx",
    rompe: (t) =>
      t
        .replace("import { memo, useCallback, useLayoutEffect, useRef, useState } from \"react\";", "import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from \"react\";")
        .replace(
          "  const unread = anchor === null ? 0 : Math.max(0, blocks.length - anchor);",
          [
            "  const [unread, setUnread] = useState(0);",
            "  useEffect(() => {",
            "    setUnread(anchor === null ? 0 : Math.max(0, blocks.length - anchor));",
            "  }, [anchor, blocks.length]);",
          ].join("\n"),
        ),
  },
  {
    // Quitar el portal: el dialogo vuelve a su sitio y el `backdrop-blur` del footer lo
    // convierte en bloque contenedor del `fixed`.
    nombre: "el dialogo de confirmar sin portal, dentro del footer con backdrop-blur",
    fichero: "src/components/ExportMenu.tsx",
    rompe: (t) =>
      t
        .replace("import { createPortal } from \"react-dom\";\n", "")
        .replace("  return createPortal(", "  return (")
        .replace(/^\s*document\.body,$/mu, "    null,"),
  },
  {
    // El bug por descuido: `slide-up-fade` es un copia de `fade-in` con otro nombre.
    // Compila, no hay ni un error, y el ritmo largo del bloque de texto se pierde.
    nombre: "slide-up-fade calcado de fade-in: 6 px en vez de 12",
    fichero: "src/app/globals.css",
    rompe: (t) =>
      t.replace(
        /(@keyframes slide-up-fade \{[^}]*?transform: translateY\()12px(\))/u,
        "$16px$2",
      ),
  },
  {
    // La misma clase de fallo que el AGENTS.md prohibe: animar `top` en vez de
    // `transform` para "no complicarse" el keyframe.
    nombre: "la entrada del bloque animando `top` en vez de `transform`",
    fichero: "src/app/globals.css",
    rompe: (t) =>
      t.replace(
        /@keyframes slide-up-fade \{[^}]*?\}/u,
        "@keyframes slide-up-fade {\n  from {\n    opacity: 0;\n    top: 12px;\n  }\n  to {\n    opacity: 1;\n    top: 0;\n  }\n}",
      ),
  },
  {
    // El antipatron "obvio" del buscador: `RegExp` con la `g` para no escribir el bucle.
    // Es un ReDoS a pocos caracteres y corre en el hilo que pinta.
    nombre: "el buscador con `new RegExp`, que es el ReDoS",
    fichero: "src/lib/search.ts",
    rompe: (t) =>
      t.replace(
        "  const tramos: Match[] = [];",
        '  const re = new RegExp(objetivo, "gi");\n  const tramos: Match[] = [];',
      ),
  },
  {
    // La forma exacta en que el usuario lo pidio: la rampa cruda de Tailwind en vez del
    // token del tema.
    nombre: "el acento del marcador con la rampa cruda `amber-400`",
    fichero: "src/components/TranscriptStream.tsx",
    rompe: (t) =>
      t.replace(
        '"border-flare bg-flare/[0.07] hover:border-flare"',
        '"border-amber-400 bg-amber-500/10 hover:border-amber-400"',
      ),
  },
  {
    // Colapsar lo que queda fuera de la ventana en vez de dejar hueco: el historial
    // ventilado ocupa menos de lo que mide y el scroll salta al cerrarse un bloque.
    nombre: "la ventana sin espaciadores: la altura total se colapsa",
    fichero: "src/components/TranscriptStream.tsx",
    rompe: (t) => t.replace(/\s*\{ventana\.(arribaPx|abajoPx) > 0 && \([\s\S]*?\)\}\n/gu, "\n"),
  },
  {
    // Renombrar el evento solo en TS: el backend emite el viejo, la UI ya no escucha y el
    // modo mini se activa sin que la maqueta cambie. No da error de compilacion.
    nombre: "el evento del modo mini renombrado solo en TypeScript",
    fichero: "src/lib/types.ts",
    rompe: (t) => t.replace('miniMode: "mini-mode-changed"', 'miniMode: "mini-window-changed"'),
  },
  {
    // Quitar el guardia: el atajo se queda con los eventos de cualquier campo de texto, y
    // `Ctrl+B` marcaria la ultima frase mientras el usuario pone negrita.
    nombre: "el atajo sin el guardia de campos de texto",
    fichero: "src/lib/useShortcuts.ts",
    rompe: (t) => t.replace("  if (destino.isContentEditable) return true;\n", ""),
  },
  {
    // La UI decide el modo mini por su cuenta: la ventana de Tauri se queda a tamano
    // completo y el aviso de transcripcion dentro, que es lo que el modo mini evita.
    nombre: "el modo mini decidido en la UI, sin redimensionar la ventana",
    fichero: "src/app/page.tsx",
    rompe: (t) =>
      t.replace(
        /const estado = await call<MiniModeStatus>\("toggle_mini_mode"\);\n\s*setMini\(estado\.active\);/u,
        "setMini((v) => !v);",
      ),
  },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lyricstream-mutacion-"));
let supervivientes = 0;

try {
  // Copia `src/` una vez: cada mutacion parte de la copia intacta.
  fs.cpSync(path.join(RAIZ, "src"), path.join(tmp, "src"), { recursive: true });

  // Y `src-tauri/src/stt.rs`, porque el test estructural del evento del modo mini cruza
  // TypeScript con Rust: lee `src/lib/types.ts` y este fichero. Sin copiarlo, ese test
  // leeria de un arbol que no existe y fallaria en TODAS las mutaciones por culpa del
  // arnes, no del codigo. Copia puntual del fichero y no del crate entero: no hace falta
  // compilarlo, solo leer su texto.
  fs.mkdirSync(path.join(tmp, "src-tauri", "src"), { recursive: true });
  fs.cpSync(
    path.join(RAIZ, "src-tauri", "src", "stt.rs"),
    path.join(tmp, "src-tauri", "src", "stt.rs"),
  );

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
