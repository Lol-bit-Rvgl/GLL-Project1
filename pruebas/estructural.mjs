import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

// Test estructural, en el repo a proposito: este comprueba el CODIGO FUENTE, no la
// logica pura, y por eso no puede vivir en el banco temporal.
//
// Que vigila: dos de los tres bugs del vumetro aparecieron solo en vivo, con CDP sobre
// la ventana de Tauri, y los 41 casos del banco de logica pura no los cazaron porque
// `vu.ts` es correcto: el fallo estaba en el punto de llamada, dentro de un componente
// React que el banco no monta. Un test estructural cubre ese hueco sin necesitar un
// runner de frontend, que el repo prohibe expresamente.
//
// Se ejecuta con node puro: `node pruebas/estructural.mjs`. Sin dependencias, sin
// transformacion, sin jsdom.

// `import.meta.dirname` y no `__dirname`: este fichero es ESM (`package.json` no
// declara `"type"` y el repo ya usa ESM en `eslint.config.mjs` y
// `postcss.config.mjs`, asi que la extension `.mjs` manda).
//
// La raiz es un argumento a proposito. Sin el, comprobar que estos tests FALLAN sobre
// el codigo roto habria que editar el repo en cada mutacion; con el se copia `src/`
// a un temporal, se rompe ahi y se ejecuta contra la copia. Ver `pruebas/mutacion.mjs`.
const RAIZ = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(import.meta.dirname, "..");
const LEDS_ESPERADAS = 48;

// --------------------------------------------------------------------------
// Lector de fuente: todo se comprueba sobre el texto real del fichero, para que un
// fallo diga "en la linea N" en vez de "algo no cuadra".
// --------------------------------------------------------------------------
function fuente(rel) {
  const abs = path.join(RAIZ, rel);
  assert.ok(
    fs.existsSync(abs),
    "no existe " + rel + ": el test estructural apunta a un fichero que se ha movido",
  );
  return fs.readFileSync(abs, "utf8");
}

// --------------------------------------------------------------------------
// 1. Anti-fuga del indice en el `map`.
//
// El bug: `vuEnvelope(level.history).map(vuBarScale)`. `Array.prototype.map` invoca el
// callback con `(valor, indice, array)`, y el segundo parametro de `vuBarScale` es
// `floor`. Con el nivel en [0,1], `valor <= indice` era siempre cierto y la funcion
// devolvia el indice. Medido en vivo, la fila salia scaleY(0), scaleY(1), ...
// scaleY(47). El vumetro no respondia al audio.
//
// La comprobacion es sobre el fuente porque el fallo es de ARIDAD en un punto de
// llamada, no de comportamiento: `vuBarScale` es correcta, lo que estaba mal era quien
// la llamaba. Un test de valores no lo ve, porque los valores que pasaban eran validos.
// --------------------------------------------------------------------------
function testAntiFugaDelIndice() {
  const rel = "src/components/VuMeter.tsx";
  const texto = fuente(rel);

  // El patron peligroso, tal cual aparecio: pasar la funcion desnuda a `map`.
  const desnudos = [];
  for (const linea of texto.split("\n")) {
    // Se limpian los comentarios, porque el texto del bug esta escrito en uno y
    // avisar de el forma parte de la explicacion.
    const limpio = linea.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    if (/\.map\(\s*vu(BarScale|Envelope)\s*[,)]/.test(limpio) && !/=>/.test(limpio)) {
      desnudos.push(limpio.trim());
    }
  }
  assert.equal(
    desnudos.length,
    0,
    "en " + rel + " se pasa una funcion con segundo parametro numerico a .map() sin " +
      "envolverla en una flecha:\n  " + desnudos.join("\n  ") + "\nmap llama con " +
      "(valor, indice, array) y el indice se colaria como floor.",
  );

  // Y que la llamada correcta este presente de verdad, no que simplemente no haya
  // ninguna llamada peligrosa: asi el test falla tambien si alguien borra el vumetro.
  assert.match(
    texto,
    /\.map\(\s*\(\s*\w+\s*\)\s*=>\s*vuBarScale\(\s*\w+\s*\)\s*\)/,
    "en " + rel + " no se encuentra `vuEnvelope(...).map((valor) => vuBarScale(valor))`. " +
      "La flecha es lo que impide que el indice se cuele como segundo argumento.",
  );
}

// --------------------------------------------------------------------------
// 2. La firma de `vuBarScale` conserva su segundo parametro.
//
// Un arreglo podria ser "quitar el segundo parametro de vuBarScale". Entonces el bug
// del `.map(vuBarScale)` desaparece por el motivo equivocado y `vu.ts` pierde la
// capacidad de fijar el suelo. Este test fija la firma, para que la unica forma de
// arreglar la fuga sea envolver la llamada.
// --------------------------------------------------------------------------
function testFirmaDeVuBarScale() {
  const texto = fuente("src/lib/vu.ts");
  const firma = texto.match(/export function vuBarScale\(([^)]*)\)/);
  assert.ok(firma, "vu.ts ya no exporta `vuBarScale` con esa firma; actualiza este test");
  assert.match(
    firma[1],
    /\bfloor\s*(:\s*number\s*)?=/,
    "vuBarScale ya no recibe `floor`. Si se quito a proposito, el arreglo del vumetro " +
      "tiene que ser envolver la llamada en una flecha, y no cambiar la firma.",
  );
}

// --------------------------------------------------------------------------
// 3. La fila tiene siempre el mismo numero de barras.
//
// Segundo bug: la fila era "tantas barras como muestras tenga el historial", y el
// historial se llena a 10 muestras por segundo. Durante los primeros ~4,8 s de cada
// captura la fila crecia de 1 a 48 LEDs (medido: 28, 43, 48) y, como cada barra es
// `flex-1`, el ancho del medidor cambiaba en cada repintado.
// --------------------------------------------------------------------------
function testFilaDeLongitudConstante() {
  const texto = fuente("src/components/VuMeter.tsx");
  const declaracion = texto.match(/const\s+LEDS\s*=\s*(\d+)\s*;/);
  assert.ok(declaracion, "VuMeter.tsx ya no declara `LEDS`; este test necesita saber cuantas barras se pintan");
  const leds = Number(declaracion[1]);
  assert.equal(
    leds,
    LEDS_ESPERADAS,
    "LEDS paso de " + LEDS_ESPERADAS + " a " + leds + "; actualiza el test o justifica el cambio",
  );

  // La fila se construye con un relleno explicito a LEDS, no sobre la longitud del
  // historial. Un `history.length === 0 ? [] : ...` seria volver al bug.
  assert.ok(
    /Array\.from\(\{\s*length:\s*LEDS\s*-/.test(texto) || /vuBarScale\(0\)\s*\)\s*\]/.test(texto),
    "VuMeter.tsx no rellena la fila a LEDS barras. Sin el relleno, la longitud la " +
      "manda el historial y la fila crece durante los primeros segundos de cada captura.",
  );
  assert.ok(
    /envelope\.length\s*>=\s*LEDS/.test(texto) || /length\s*>=\s*LEDS/.test(texto),
    "VuMeter.tsx no recorta la fila a LEDS cuando el historial es mas largo, con lo que " +
      "la fila crecia sin limite en una sesion larga.",
  );
}

// --------------------------------------------------------------------------
// 4. La pista tiene ancho para los 48 LEDs. Tercer bug, el mas caro.
//
// El grupo no crecia dentro de un pie `flex-wrap justify-between`, y como no llevaba
// `flex-1` se ajustaba a su contenido. La pista, que si es `flex-1`, se quedaba en
// 51 px para 48 barras; los 47 huecos de `gap-px` se comian 47 de esos 51 px, cada
// barra salia a 0,04 px y el navegador la pintaba a 0 px de dispositivo. El vumetro
// era invisible siempre, incluso con la fila entera encendida.
//
// Aqui se hace el calculo de verdad: el ancho que la pista necesita para que N barras
// con un hueco entre ellas quepan en un pixel cada una, y se comprueba que el `min-w`
// declarado da al menos eso. Es la misma cuenta que hacia el navegador, pero sin
// necesitar una ventana.
// --------------------------------------------------------------------------
function testAnchoDeLaPista() {
  const texto = fuente("src/components/VuMeter.tsx");

  // `gap-px` son 1 px y `p-0.5` son 0.125rem = 2 px por lado.
  const HUECO = 1;
  const RELLENO_POR_LADO = 2;
  const huecos = LEDS_ESPERADAS - 1;
  const minimoPista = LEDS_ESPERADAS * 1 + huecos * HUECO + RELLENO_POR_LADO * 2;

  // El `min-w` del grupo tiene que ser el de la pista mas lo que hay al lado: el hueco
  // `gap-3` (0.75rem = 12 px) y la lectura dB, que es `w-14` (3.5rem = 56 px).
  const GAP_GRUPO = 12;
  const LECTURA_DB = 56;
  const minimoGrupo = minimoPista + GAP_GRUPO + LECTURA_DB;

  const declarado = texto.match(/min-w-\[(\d+)px\]/);
  assert.ok(
    declarado,
    "el grupo de VuMeter.tsx no declara min-w en px. Es lo que mantiene el ancho: sin " +
      "el, el div se ajusta a su contenido y las barras se quedan sin pixel.",
  );
  const minW = Number(declarado[1]);
  assert.ok(
    minW >= minimoGrupo,
    "min-w de " + minW + " px no llega: la pista necesita " + minimoPista + " px (" +
      LEDS_ESPERADAS + " barras de 1 px + " + huecos + " huecos de " + HUECO + " px + " +
      RELLENO_POR_LADO * 2 + " de relleno), y el grupo necesita ademas " + GAP_GRUPO +
      " de hueco y " + LECTURA_DB + " de lectura dB. Con " + minW + " px las barras " +
      "salen por debajo de 1 px de ancho y el vumetro se invisibiliza.",
  );

  // El relleno de la pista tiene que seguir siendo de 2 px por lado. Si cambia, la cuenta
  // de arriba deja de ser valida y el fallo seria de este test, no del vumetro.
  const pista = texto.match(/className="([^"]*h-6[^"]*)"/);
  assert.ok(pista, "no se encuentra la pista del vumetro (el div con h-6)");
  assert.match(
    pista[1],
    /\bp-0\.5\b/,
    "la pista ya no lleva p-0.5. La cuenta de ancho minimo de este test asume 2 px de " +
      "relleno por lado; si el relleno cambia, hay que actualizar RELLENO_POR_LADO aqui.",
  );
}

// --------------------------------------------------------------------------
// 5. El track de las barras es `flex-1` y las barras reparten el ancho.
//
// El mismo bug del punto 4 visto desde el otro lado. Si las barras dejaran de ser
// `flex-1`, dejarian de repartirse y el `min-w` ya no bastaria para dibujarlas.
// --------------------------------------------------------------------------
function testLasBarrasRepartenElAncho() {
  const texto = fuente("src/components/VuMeter.tsx");
  assert.match(
    texto,
    /className="flex h-6 flex-1 items-end/,
    "la pista ha dejado de ser `flex-1`: sin crecer dentro del grupo, el min-w del " +
      "grupo no le llega y las barras vuelven a 0 px.",
  );
  assert.match(
    texto,
    /vu-bar min-w-0 flex-1/,
    "las barras han dejado de ser `flex-1 min-w-0`. Sin repartirse el ancho, el ancho " +
      "de la pista no se convierte en 48 barras visibles.",
  );
}

// --------------------------------------------------------------------------
// 6. El timestamp usa el ambar del tema a opacidad plena.
//
// `text-flare/60` compone #ff9d00 al 60 % sobre obsidian, o sea #9c6108, que no es el
// ambar pedido y deja el texto en 3.92:1, por debajo del 4.5:1 que WCAG AA exige a
// 12 px. A opacidad plena son 9.55:1. Es un modificador de opacidad, asi que un test
// estructural sobre el className lo detecta sin medir contrastes.
// --------------------------------------------------------------------------
function testTimestampSinModificadorDeOpacidad() {
  const rel = "src/components/TranscriptStream.tsx";
  const texto = fuente(rel);
  const linea = texto.match(/className="[^"]*\btext-flare\b[^"]*"/);
  assert.ok(linea, "no se encuentra el span del timestamp en " + rel);
  assert.ok(
    !/text-flare\/\d+/.test(linea[0]),
    "el timestamp vuelve a llevar un modificador de opacidad (" + linea[0].trim() +
      "). Sobre obsidian compone un color que no es el del tema y baja de 4.5:1.",
  );
}

// --------------------------------------------------------------------------
// Arranque
// --------------------------------------------------------------------------
const tests = [
  ["vuBarScale no recibe el indice de map() como floor", testAntiFugaDelIndice],
  ["la firma de vuBarScale conserva el parametro floor", testFirmaDeVuBarScale],
  ["la fila tiene siempre 48 barras", testFilaDeLongitudConstante],
  ["la pista tiene ancho para 48 barras", testAnchoDeLaPista],
  ["las barras reparten el ancho con flex-1", testLasBarrasRepartenElAncho],
  ["el timestamp va a opacidad plena", testTimestampSinModificadorDeOpacidad],
];

let fallos = 0;
for (const [nombre, fn] of tests) {
  try {
    fn();
    console.log("  ok   " + nombre);
  } catch (err) {
    fallos += 1;
    console.log("  FALLA " + nombre);
    console.log("       " + String(err.message).split("\n").join("\n       "));
  }
}

if (fallos === 0) {
  console.log("\nTODO OK (" + tests.length + " estructurales)");
  process.exit(0);
} else {
  console.log("\n" + fallos + " FALLAS de " + tests.length);
  process.exit(1);
}
