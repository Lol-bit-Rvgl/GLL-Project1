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
// 7. El indicador del conmutador de fuente se mueve con `transform`.
//
// El bug: cambiar el indicador deslizante a `transition-[left]` con `left-full` en el
// segundo estado. Se ve bien en reposo, porque el estado inicial no se anima; el coste
// aparece al cambiar de fuente, que es cuando recalcula la composicion del encabezado
// entero en cada frame. Y el encabezado esta en la misma pagina que la transcripcion y el
// vumetro, que ya compiten por el hilo principal.
//
// Se comprueba que la transicion sea de `transform` y que no se anime ninguna propiedad
// de disposicion. La lista negra es nominal a proposito: `left-0.5` es la posicion inicial
// legitima y no puede prohibirse.
// --------------------------------------------------------------------------
function testElIndicadorSeMueveConTransform() {
  const rel = "src/components/ControlBar.tsx";
  const texto = fuente(rel);

  // El indicador es el `span` con la posicion absoluta y el ancho de la mitad.
  const marca = texto.match(/className=\{`([^`]*absolute inset-y-0\.5[^`]*)`\}/u);
  assert.ok(
    marca,
    "no se encuentra el indicador del conmutador en " + rel +
      " (se busca el span con `absolute inset-y-0.5` y ancho de la mitad)",
  );

  assert.ok(
    marca[1].includes("transition-transform"),
    "el indicador del conmutador no transiciona `transform` (" + marca[1].trim() +
      "). Sin eso, el deslizamiento no se anima de forma compuesta.",
  );

  // Ninguna propiedad de disposicion, y ninguna transicion global o arbitraria: si alguien
  // escribe `transition-all` la comprobacion de arriba pasa y el bug vuelve.
  const disposicion = marca[1].match(/transition-\[(?:left|right|top|inset|width|all)[^\]]*\]/u);
  assert.ok(
    disposicion === null,
    "el indicador del conmutador vuelve a animar una propiedad de disposicion (" +
      disposicion?.[0] + "). Relayouta el encabezado entero en cada frame.",
  );
  assert.ok(
    !/(^|\s)transition-all(\s|$)/u.test(marca[1]),
    "el indicador del conmutador usa `transition-all` (" + marca[1].trim() +
      "): deja pasar a `left` sin que este test lo note.",
  );

  // Y tiene que haber dos posiciones de verdad, no una sola con la animacion puesta.
  assert.ok(
    /translate-x-\[calc\(100%\+/u.test(texto),
    "el conmutador no tiene la segunda posición del indicador en " + rel,
  );
}

// --------------------------------------------------------------------------
// 8. La entrada del bloque va con `motion-safe`.
//
// El bug: quitar el `motion-safe:` de `motion-safe:animate-[slide-up-fade...]`. Con la
// preferencia de menos movimiento activa, cada frase cerrada entra 12 px igual: en un
// canal de texto que se actualiza cada medio segundo, media pantalla de scroll moviéndose
// sola es justo el patron que esa preferencia existe para desactivar.
//
// `fade-in` y `slide-up-fade` se distinguen por el prefijo, no por el contenido, asi que
// la comprobacion tiene que mirar el `motion-safe:` y no solo el nombre de la animacion.
// --------------------------------------------------------------------------
function testLaEntradaDelBloqueRespetaReducedMotion() {
  const rel = "src/components/TranscriptStream.tsx";
  const texto = fuente(rel);

  const animaciones = [...texto.matchAll(/(\S*)animate-\[slide-up-fade_/gu)].map((m) => m[1]);
  assert.ok(
    animaciones.length > 0,
    "no se encuentra ninguna entrada `slide-up-fade` en " + rel +
      ", asi que los bloques ya no entran animada",
  );
  for (const prefijo of animaciones) {
    assert.ok(
      prefijo.endsWith("motion-safe:"),
      "una entrada `slide-up-fade` no va envuelta en `motion-safe:` (queda como `" +
        prefijo + "animate-[slide-up-fade...`). Con menos movimiento pedido, cada frase " +
        "cerrada sigue entrando 12 px.",
    );
  }
}

// --------------------------------------------------------------------------
// 9. El contador de frases sin leer se deriva, no se cuenta en un efecto.
//
// El bug: reescribir el contador como `useEffect(() => setUnread(blocks.length - visto), [blocks.length])`.
// Compila, funciona, y `npm run lint` lo pasa... salvo que este repo tiene las reglas del
// React Compiler en modo error, asi que falla el lint. Y aunque pasara, el `setState` en un
// efecto pinta el historial entero una vez mas por cada frase.
//
// Aqui el estado guarda el ANCLA (el punto donde se solto el usuario) y la cuenta se
// deriva al renderizar. Por eso el fichero no debe tener ningun `useEffect`: el unico
// efecto de scroll es un `useLayoutEffect` que escribe `scrollTop`, que no es estado.
// --------------------------------------------------------------------------
function testElContadorSeDerivaYNoUsaEfecto() {
  const rel = "src/components/TranscriptStream.tsx";
  const texto = fuente(rel);

  assert.ok(
    !/useEffect\(/u.test(texto),
    "TranscriptStream ha aparecido un `useEffect` (" + rel + "). El contador de frases " +
      "sin leer se deriva del ancla durante el render; un efecto aqui solo puede servir " +
      "para contar, y contar en un efecto es lo que este test existe para impedir.",
  );

  // La derivacion tiene que estar, no solo la ausencia del efecto: si se borra el
  // contador entero el fichero sigue sin `useEffect` y el test pasaria sin motivo.
  assert.ok(
    /anchor === null \? 0 : Math\.max\(0, blocks\.length - anchor\)/u.test(texto),
    "no se encuentra la derivacion del contador de frases sin leer en " + rel +
      ". Se esperaba `anchor === null ? 0 : Math.max(0, blocks.length - anchor)`.",
  );
}

// --------------------------------------------------------------------------
// 10. El dialogo de confirmacion va en un portal.
//
// El bug: devolver el dialogo a su sitio, dentro del arbol normal. Sigue siendo
// `position: fixed`, pero su ancestro -el `footer` de la pagina- tiene `backdrop-blur`, y
// cualquier ancestro con `backdrop-filter` se convierte en bloque contenedor de los
// descendientes fijos. El `fixed` deja de medir contra la ventana y mide contra esa franja
// de 40 px: el fondo opaco cubre solo la barra inferior y el recuadro sale centrado en
// ella. Es un boton flotando con su sombra y sin modal alrededor.
//
// El overlay de `DropZone` tiene el mismo motivo y la misma solucion, y por eso el
// comentario de `ConfirmDialog` remite a el.
// --------------------------------------------------------------------------
function testElDialogoDeConfirmacionVaEnUnPortal() {
  const rel = "src/components/ExportMenu.tsx";
  const texto = fuente(rel);

  assert.ok(
    /import \{ createPortal \} from "react-dom";/u.test(texto),
    rel + " no importa `createPortal`. Sin el, el dialogo de confirmar queda dentro del " +
      "`footer`, y su `backdrop-blur` lo convierte en bloque contenedor del `fixed`.",
  );

  // El `return` de `ConfirmDialog` tiene que ser el portal, no el `<div>`.
  const cuerpo = texto.slice(texto.indexOf("function ConfirmDialog"));
  assert.ok(
    /return createPortal\(/u.test(cuerpo),
    "ConfirmDialog no devuelve `createPortal(...)`. El `fixed inset-0` se mediria contra " +
      "el `footer` con `backdrop-blur` y no contra la ventana.",
  );
  assert.ok(
    /document\.body/u.test(cuerpo),
    "el portal de ConfirmDialog no apunta a `document.body`.",
  );
}

// --------------------------------------------------------------------------
// 11. `fade-in` y `slide-up-fade` son dos keyframes distintos.
//
// El bug: copiar `fade-in` sobre `slide-up-fade` al añadir el segundo. Los dos se siguen
// nombrando donde toca, el CSS compila y no hay ni un error, pero el bloque de texto
// entra 6 px como un etiqueta cualquiera y el ritmo largo se pierde sin que nada lo
// note. Un test de nombres no lo veria, asi que se comparan las dos distancias.
//
// Tambien se comprueba que solo se animen `transform` y `opacity`: un `top` o un `height`
// en un keyframe de entrada relayouta la columna entera en cada frase.
// --------------------------------------------------------------------------
function testLosDosKeyframesDeEntradaSonDistintos() {
  const texto = fuente("src/app/globals.css");

  const distancia = (nombre) => {
    const bloque = texto.match(
      new RegExp("@keyframes " + nombre + "\\s*\\{([\\s\\S]*?)\\n\\}", "u"),
    );
    assert.ok(bloque, "no se encuentra `@keyframes " + nombre + "` en globals.css");
    const corto = bloque[1].match(/translateY\((\d+)px\)/u);
    assert.ok(
      corto !== null,
      "`@keyframes " + nombre + "` no declara un `translateY` en px. La animacion de " +
        "entrada se hace con `transform`, no con `top`.",
    );
    // Solo se permite `transform` y `opacity` en el bloque. El recorte es `\\n\\s+` y
    // no `^\\s{2}` porque el CSS indenta con DOS espacios dentro del keyframe y con
    // CUATRO dentro de `from`/`to`: contando la sangria exacta, las cuatro lineas de
    // aqui abajo no casaban con nada y el bucle no se ejecutaba nunca. Un test que
    // recorre una lista vacia pasa siempre, y ademas habria dejado pasar justo el
    // `top` que este test existe para cazar.
    const propiedades = [...bloque[1].matchAll(/(?:^|\n)\s+([a-z-]+)\s*:/gu)].map((m) => m[1]);
    assert.ok(
      propiedades.length > 0,
      "`@keyframes " + nombre + "` no tiene ninguna propiedad: el keyframe esta vacio y " +
        "la animacion no haria nada.",
    );
    for (const propiedad of propiedades) {
      assert.ok(
        ["opacity", "transform"].includes(propiedad),
        "`@keyframes " + nombre + "` anima `" + propiedad + "`. Solo se admite " +
          "`transform` y `opacity`: cualquier propiedad de disposicion relayouta la " +
          "columna de texto entera en cada bloque.",
      );
    }
    return Number(corto[1]);
  };

  const corto = distancia("fade-in");
  const largo = distancia("slide-up-fade");

  assert.ok(
    largo > corto,
    "`slide-up-fade` desplaza " + largo + " px y `fade-in` " + corto +
      " px. El bloque de texto entra mas lejos que un elemento pequeno, y si los dos " +
      "mueven lo mismo son el mismo keyframe con dos nombres.",
  );
}

// --------------------------------------------------------------------------
// 12. El buscador no usa `RegExp`.
//
// La tentacion es `new RegExp(texto, "gi")`, que ademas resuelve el `g` de golpe. Pero un
// patron como `a|a|a|a` contra una frase larga hace trabajo exponencial (ReDoS), y este
// buscador corre en el MISMO hilo que pinta la transcripcion: un texto de busqueda raro
// congela la ventana entera. Aqui se comparan subcadenas, que es lineal.
//
// Los comentarios del fichero mencionan `new RegExp(texto, "gi")` como el antipatron, asi
// que hay que quitarlos antes de comprobar: si no, el test fallaria por su propia
// documentacion.
// --------------------------------------------------------------------------
function sinComentarios(texto) {
  // Bloque `/* ... */` (incluye el de documentacion `/** ... */`) y luego linea `// ...`.
  return texto.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

function testElBuscadorNoUsaRegExp() {
  const rel = "src/lib/search.ts";
  const limpio = sinComentarios(fuente(rel));

  assert.ok(
    !/new RegExp\(/u.test(limpio),
    "el buscador vuelve a construir un `RegExp` en " + rel + ". `new RegExp(texto, \"gi\")` " +
      "se pone en ReDoS con pocos caracteres y corre en el hilo que pinta la " +
      "transcripcion, asi que la ventana entera se congela.",
  );
  assert.ok(
    /\.indexOf\(/u.test(limpio),
    "el buscador ya no usa `indexOf`: si no compara subcadenas, con que compara? " +
      "El motor de subcadenas es lo que lo hace lineal.",
  );
}

// --------------------------------------------------------------------------
// 13. El acento del bloque marcado usa los tokens del tema, no la rampa cruda.
//
// El pedido original decia `border-amber-400 bg-amber-500/10`, que es la rampa cruda de
// Tailwind. `AGENTS.md` explica que los tokens existen justo para que nadie escriba
// `amber-400` en un sitio y `orange-500` en otro pensando que son el mismo color, y la
// hoja generada se verifica contra los tokens. El acento es `border-flare bg-flare/...`.
//
// Se comprueba sobre el fuente sin comentarios, porque el comentario de `BlockRow`
// explica el antipatron y nombrarlo forma parte de la explicacion.
// --------------------------------------------------------------------------
function testElAcentoDelMarcadorUsaLosTokens() {
  const rel = "src/components/TranscriptStream.tsx";
  const limpio = sinComentarios(fuente(rel));

  const rampa = limpio.match(/\b(?:amber|orange|yellow|red)-\d{2,3}\b/u);
  assert.ok(
    rampa === null,
    "el acento del bloque marcado vuelve a la rampa cruda (`" + rampa?.[0] + "`). Los " +
      "tokens del tema existen para que el ambar sea uno solo; usa `border-flare` y " +
      "`bg-flare/...`.",
  );
  assert.ok(
    /\bborder-flare\b/u.test(limpio),
    "el bloque marcado ya no lleva `border-flare`: el acento del tema ha desaparecido " +
      "del marcador.",
  );
  assert.ok(
    /\bbg-flare\/\[/u.test(limpio),
    "el bloque marcado ya no tiñe el fondo con una opacidad del token `flare` " +
      "(`bg-flare/[0.07]`).",
  );
}

// --------------------------------------------------------------------------
// 14. La ventana no colapsa la altura: los dos espaciadores se pintan.
//
// Es la garantia central del esquema (`src/lib/windowing.ts`): la altura TOTAL no cambia
// nunca, solo cambia cuantos `<div>` existen. Sin los dos espaciadores, el historial
// viejo no ocupa sitio, el contenido de abajo sube y el usuario que lee la mitad ve
// saltar el texto bajo el cursor en cada bloque cerrado.
//
// Los dos van `aria-hidden`: son hueco, no contenido, y no deben anunciarse.
// --------------------------------------------------------------------------
function testLaVentanaConservaLosEspaciadores() {
  const rel = "src/components/TranscriptStream.tsx";
  const texto = fuente(rel);

  assert.ok(
    /\{ventana\.arribaPx > 0 && \(/u.test(texto),
    rel + " ya no pinta el espaciador de arriba (`ventana.arribaPx > 0 &&`). Sin el, el " +
      "historial ventilado ocupa menos de lo que mide y el scroll salta.",
  );
  assert.ok(
    /\{ventana\.abajoPx > 0 && \(/u.test(texto),
    rel + " ya no pinta el espaciador de abajo (`ventana.abajoPx > 0 &&`).",
  );

  for (const lado of ["arribaPx", "abajoPx"]) {
    const espaciador = texto.match(
      new RegExp("height: ventana\\." + lado + "\\s*\\}", "u"),
    );
    assert.ok(
      espaciador !== null,
      rel + " no da altura al espaciador con `ventana." + lado + "`.",
    );
  }
  const aria = [...texto.matchAll(/style=\{\{ height: ventana\.\w+Px \}\}([^>]*)/gu)];
  assert.ok(aria.length >= 2, "no se encuentran los dos divs de hueco en " + rel);
  for (const m of aria) {
    assert.ok(
      /aria-hidden="true"/u.test(m[1]),
      "un espaciador de la ventana no lleva `aria-hidden`: es hueco y el lector de " +
        "pantalla lo anunciaria.",
    );
  }
}

// --------------------------------------------------------------------------
// 15. El evento del modo mini coincide entre TypeScript y Rust.
//
// El nombre del evento esta escrito dos veces: la constante `EVENTS.miniMode` en
// `src/lib/types.ts` y `EVENT_MINI_MODE` en `src-tauri/src/stt.rs`. Rust lo emite y TS lo
// escucha. Un cambio en uno y no en el otro NO da error de compilacion: el modo mini se
// activa, la ventana encoge y la UI se queda en grande porque el evento nunca llega.
// Se comparan las dos cadenas.
// --------------------------------------------------------------------------
function testElEventoDelModoMiniCoincide() {
  const ts = fuente("src/lib/types.ts");
  const rs = fuente("src-tauri/src/stt.rs");

  const enTs = ts.match(/miniMode:\s*"([^"]+)"/u);
  assert.ok(enTs, "no se encuentra `miniMode: \"...\"` en src/lib/types.ts");
  const enRs = rs.match(/EVENT_MINI_MODE\s*:\s*&?str\s*=\s*"([^"]+)"/u);
  assert.ok(enRs, "no se encuentra `EVENT_MINI_MODE: &str = \"...\"` en src-tauri/src/stt.rs");

  assert.equal(
    enTs[1],
    enRs[1],
    "el evento del modo mini no coincide: TS escucha \"" + enTs[1] + "\" y Rust emite \"" +
      enRs[1] + "\". El modo mini se activaria sin que la UI se enterase.",
  );
}

// --------------------------------------------------------------------------
// 16. El atajo cede el paso cuando el foco esta en un campo de texto.
//
// `Ctrl+B` en un campo es negrita del navegador. Si el atajo se lo queda, escribir en
// cualquier campo de la app (renombrar una pista, por ejemplo) marcaria la ultima frase
// cada vez que alguien pusiera negrita. Se comprueba que el guardia existe.
// --------------------------------------------------------------------------
function testElAtajoCedeEnLosCamposDeTexto() {
  const rel = "src/lib/useShortcuts.ts";
  const texto = fuente(rel);

  assert.ok(
    /isContentEditable/u.test(texto),
    rel + " ya no comprueba `isContentEditable`: el atajo se quedaria con los eventos de " +
      "un editor de texto enriquecido.",
  );
  assert.ok(
    /tagName/u.test(texto) && /"INPUT"/u.test(texto) && /"TEXTAREA"/u.test(texto),
    rel + " ya no mira `tagName` para distinguir un `INPUT`/`TEXTAREA` del resto. Sin " +
      "eso, `Ctrl+B` no cede el paso en ningun campo.",
  );
}

// --------------------------------------------------------------------------
// 17. El modo mini lo decide el backend, no un estado local de la UI.
//
// El tamano de la ventana, el `always_on_top` y el minimo son de Rust. Si la UI se
// limitara a un `useState` y a cambiar su propia maqueta, la ventana seguiria a tamano
// completo con el aviso de transcripcion dentro, que es justo lo que el modo mini
// existe para evitar. Se comprueba que la pagina habla con los dos comandos y que no
// redimensiona la ventana por su cuenta.
// --------------------------------------------------------------------------
function testElModoMiniLoDecideElBackend() {
  const rel = "src/app/page.tsx";
  const texto = fuente(rel);

  assert.ok(
    /"toggle_mini_mode"/u.test(texto),
    rel + " no llama a `toggle_mini_mode`: la UI decidiria el modo mini por su cuenta y " +
      "la ventana de Tauri no cambiaria de tamano.",
  );
  assert.ok(
    /"get_mini_mode"/u.test(texto),
    rel + " no llama a `get_mini_mode`: al recargar la webview con la mini activa, la UI " +
      "no sabria en que modo esta.",
  );
  assert.ok(
    /EVENTS\.miniMode/u.test(texto),
    rel + " no escucha `EVENTS.miniMode`: si el backend cambia el modo por otra via, la " +
      "UI se quedaria desincronizada.",
  );
  assert.ok(
    !/\b(?:setSize|LogicalSize|PhysicalSize)\s*\(/u.test(texto),
    rel + " redimensiona la ventana desde la UI (`setSize`/`LogicalSize`). El tamano del " +
      "modo mini es geometria de Rust y se decide alli.",
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
  ["el conmutador de fuente se mueve con transform", testElIndicadorSeMueveConTransform],
  ["la entrada del bloque va con motion-safe", testLaEntradaDelBloqueRespetaReducedMotion],
  ["el contador de frases se deriva, no se cuenta en un efecto", testElContadorSeDerivaYNoUsaEfecto],
  ["el dialogo de confirmar va en un portal", testElDialogoDeConfirmacionVaEnUnPortal],
  ["fade-in y slide-up-fade son keyframes distintos", testLosDosKeyframesDeEntradaSonDistintos],
  ["el buscador no usa RegExp (evita el ReDoS en el hilo de pintado)", testElBuscadorNoUsaRegExp],
  ["el acento del marcador usa los tokens del tema", testElAcentoDelMarcadorUsaLosTokens],
  ["la ventana conserva los dos espaciadores de altura", testLaVentanaConservaLosEspaciadores],
  ["el evento del modo mini coincide entre TypeScript y Rust", testElEventoDelModoMiniCoincide],
  ["el atajo cede el paso en los campos de texto", testElAtajoCedeEnLosCamposDeTexto],
  ["el modo mini lo decide el backend", testElModoMiniLoDecideElBackend],
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
