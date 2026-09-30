<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes -- APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` -- verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Entorno

Antes de `cargo` o `npm run tauri`, hay que poner esto en el `PATH` de la sesion:

```powershell
$env:CARGO_HOME="D:\Rust\cargo"; $env:RUSTUP_HOME="D:\Rust\rustup"
$env:PATH="$env:PATH;D:\Rust\mingw64\mingw64\bin;D:\Rust\cargo\bin"
```

Sin esto, `cargo` no aparece: Rust no esta en el PATH del sistema.

Restricciones del equipo: 8 GB de RAM fisica (7,71 GB medidos) de los que solo queda del orden de
1 GB libres en los picos de compilacion, target `x86_64-pc-windows-gnu`, MinGW GCC 16.2. La cifra
que importa no es la instalada sino la libre: `jobs = 2`, `debug = 0` e `incremental = false` en
`.cargo/config.toml` estan puestos porque lo que se agota es la memoria durante el enlazado, no la
CPU. Compilar en `--release` tarda ~12 min; no es un error, es el objetivo por defecto. **No anadir
dependencias grandes** (`reqwest`, `ort`, `whisper`, crates de criptografia): es justo lo que
revienta la maquina. Ver "Descargas" mas abajo.

# Arquitectura

Cuatro crates, con la dependencia apuntando hacia abajo:

- `lyricstream-audio`: captura cpal/WASAPI, downmix, remuestreo a 16 kHz mono, anillos. Sin Tauri.
- `lyricstream-asr`: VAD, segmentacion, worker de inferencia, gestion de pesos, `WhisperEngine`.
  Sin Tauri. Aqui viven **todos** los tests de DSP, de modelos y de inferencia real.
- `lyricstream-whisper-sys`: puente C a whisper.cpp. Compila **solo** `csrc/shim.c` (~400 lineas);
  el codigo de whisper llega en ejecucion desde las DLL del release oficial.
- `lyricstream-stt` (raiz): capa Tauri. Solo pega las anteriores con la API de Tauri.

Regla que se ha seguido varias veces: **la logica comprobable va en los crates de abajo**, porque
el crate raiz tiene `test = false` (el enlazador de este equipo no puede arrancar el harness de
test de un binario que enlace Tauri) y ahi no se puede escribir ni un test. Si algo lleva
`serde::Serialize` y una regla de negocio, va en `lyricstream-asr`.

Estado: un solo contenedor (`src/stt.rs`, `SttState`) registra `AudioEngine` y el worker de STT.
No se separen: el worker de inferencia lee del mismo anillo de muestras que alimenta la captura.

# Descargas de modelos

Se usa `curl.exe` (el de `System32`) detras del trait `Fetcher`, no `reqwest`/`ureq`. Motivo:
evita compilar TLS en un equipo con 8 GB de RAM de los que solo queda ~1 GB libre. Cambiar de
cliente HTTP significa implementar
`Fetcher`; el resto del crate no se toca.

`ModelSpec` publica `expected_bytes` y `sha256` reales (verificados contra el fichero de
HuggingFace). No volver a 0/`None`: sin hash, un HTML de error de HTTP se pasaria por modelo
valido. El hash se confirmo bajando `ggml-tiny-q5_1.bin` y hasheandolo; el `X-Linked-ETag` de la
cabecera es el OID SHA-256 del LFS, pero conviene verificar de nuevo si se cambia de version.

# Runtime de whisper.cpp

No se compila whisper.cpp: el release de Windows no trae `.lib` y compilarlo entero revienta el
equipo. El crate sys compila un shim C que usa `LoadLibraryExW` + `GetProcAddress`, y el codigo
real llega en ejecucion. De ahi que `cargo build -p lyricstream-whisper-sys` tarde **segundos**
y no minutos.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy-whisper.ps1
```

Las DLL (~12 MB) y el WAV de muestra quedan en
`src-tauri\crates\lyricstream-whisper-sys\runtime\`, que esta en `.gitignore` por el mismo motivo
que los pesos. Sin ellas, los tests de inferencia se **omiten** (no fallan) para que `cargo test`
siga verde en una maquina limpia. La app busca el runtime en `LYRICSTREAM_WHISPER_DIR`, luego en
el `resource_dir` de Tauri, luego junto al exe y luego en el directorio de trabajo.

Tres cosas que costaron sangre y no deben romperse:

- **`ggml_backend_load_all_from_path` es obligatorio.** El backend de CPU vive en su propia DLL
  (`ggml-cpu-*.dll`) y solo se registra cuando el shim llama a esa funcion. Ni
  `whisper_init_from_file_with_params` ni `whisper_init_state` la llaman jamas: es responsabilidad
  de quien usa la libreria. Sin ella, el modelo carga bien y luego el proceso muere con
  `GGML_ASSERT(device) failed` en `ggml_backend_dev_by_type(CPU)`. Todos los ejecutables de
  whisper.cpp hacen la llamada; el shim tambien.
- **Las cabeceras mandan sobre la memoria.** `whisper_context_params` ya **no** tiene
  `n_threads` (los hilos son un parametro de decodificacion, en `whisper_full_params`), y
  `*_default_params` devuelven la estructura **por valor**, no por puntero. Si se actualiza el tag
  de las DLL hay que actualizar `vendor/whisper/`, `LRS_WHISPER_BUILD` y el test
  `el_runtime_carga_y_expone_el_commit_esperado`.
- **`ggml-base.dll` es obligatoria** aunque no lo parezca: la importan `whisper.dll` y `ggml.dll`,
  y si falta `LoadLibrary` falla con un "modulo no encontrado" que no dice cual. El script de
  despliegue la copia y lo comprueba.

# Streaming: la UI concatena

`WhisperEngine` devuelve solo el **incremento** respecto a lo ya emitido, calculado por palabras
completas, porque la UI concatena en vez de sustituir. Devolver la ventana entera repetiria la frase
en pantalla. La UI no tiene forma de decir "borra lo anterior", asi que una palabra que whisper
revierte se queda.

Los primeros parciales son **ruidosos por naturaleza**: con 1 s de audio whisper alucina
(`[INAUDIBLE]`, "you are country"). El final, con el utterance completo, es fiable. Se eligio
parciales rapidos y ruidosos antes que parciales utiles a los 2-3 s. Ver el doc de
`whisper_engine.rs` con las salidas medidas.

## El reducer de la UI: `src/lib/transcript.ts`

`page.tsx` ya no concatena segmentos en una lista plana. `reduce(estado, segmento)` mantiene **dos**
cosas separadas:

- `blocks`: frases ya cerradas (`is_final`). Inmutables. Es lo que se exporta y lo que persiste.
- `interim`: el acumulado del segmento en curso. Se **acumula** con cada parcial, no se sustituye.

Reglas que no se deben romper, cada una con un motivo:

- **El final es una cola, no la frase.** `WhisperEngine` lo emite contra la referencia del ultimo
  parcial, asi que el texto del bloque es `interim + final`. Si se descarta el `interim`, se pierde
  la cabeza de la frase; si se concatenan a pelo, se duplica.
- **`interim.start_ms` lo fija el PRIMER parcial.** Los siguientes llegan con `start_ms` mayor
  porque la ventana ha crecido hacia delante; tomarlo cada vez desplazaria la frase a la derecha
  segun avanza.
- **Un final VACIO descarta lo acumulado.** Es la unica regla que delega texto, y es deliberada: si
  el final no anade ninguna palabra, la ventana completa no produjo nada, y lo que hubiera en el
  parcial era alucinacion. Persistir `[INAUDIBLE]` en el historial y en el SRT seria el problema que
  la app promete resolver. Se acepta el riesgo opuesto (un final vacio por averia se come la frase):
  perder texto es reversible, fabricar una frase exportada no.
- **`block.id` sale del ultimo id, no de `Date.now()` ni de un contador global.** El estado
  serializado y el recien montado tienen que generar la misma secuencia de claves de React.

# Frontend

Sin dependencias nuevas: React 19, Next 16 y Tailwind 4, que ya estaban. Los iconos son SVG en
linea; no hay libreria de iconos para dos triangulos.

- `src/lib/types.ts`: espejo a mano de las estructuras `Serialize` de Rust. **Los nombres van en
  snake_case** porque serde serializa el campo tal cual esta declarado y estos `derive` no llevan
  `rename_all`. El reparto es irregular y por eso el fichero esta comentado campo a campo:
  `TranscriptionSegment`, `WorkerStats`, `EngineStatus`, `ModelInfo` y `ModelStatus` van en
  snake_case; `CaptureStatus` y `AudioDevicesInfo` si llevan `rename_all = "camelCase"` y mandan
  `inputSampleRate` / `defaultInput`. Si un dia se quiere una sola convencion, se pone el
  `rename_all` en el `derive` de Rust y se actualiza este espejo: **no** se traduce en la UI, porque
  entonces el contrato de los eventos dejaria de coincidir con el que ven los tests de Rust.
- `src/lib/transcript.ts`: el reducer. Puro y sin efectos, a proposito: se puede ejercitar entero sin
  montar React.
- `src/lib/useTranscript.ts`: eventos de Tauri, persistencia en `localStorage` (cada 5 s) y estado
  pegado al scroll. Sondeo de `get_stt_status` cada 2 s porque `stt-engine-status` **solo** se emite
  al arrancar y al parar: sin el sondeo el piso de ruido y los contadores se quedan congelados en el
  valor del arranque durante toda la sesion.
- `src/lib/useAudioLevel.ts`: vumetro aislado. Lee `get_audio_level` cada 100 ms a un `ref` y pinta
  cada 150 ms; va aparte del texto porque si no cada lectura re-renderizaria el historial entero.
- `src/lib/export.ts`: TXT, Markdown y SRT. TXT incluye el segmento en curso; MD y SRT no, porque
  un SRT con una frase a medias no significa nada.

## Reglas de React que este repo ya no puede violar

`eslint-config-next` 16 trae las reglas de React Compiler en modo error, y `npm run lint` falla si se
incumple. No sonitizedas para hacerlas pasar:

- **`react-hooks/set-state-in-effect`**: nada de `setState` sincrono en el cuerpo de un efecto. La
  carga inicial y la lectura de `localStorage` van dentro de un IIFE asincrono. Apagado el vumetro no
  hace `setLevel(0)`: se devuelve `SILENT` desde el hook.
- **`react-hooks/refs`**: nada de escribir un `ref` durante el render, ni siquiera
  `ref.current = valor`. El espejo de estado del intervalo de guardado se actualiza en un efecto.
  El autoscroll usa `stickToBottom` como dependencia del `useLayoutEffect` en vez de un `ref`
  espejo, que ademas era la logica correcta.

## Reparto de la pantalla, y por que es el que hay

Medido con `D:\Temp\opencode\medir.mjs` sobre el export estatico a 1000x700, con el historial
desbordando y un doble de las APIs de Tauri. **No razonar estos numeros, medirlos**: las tres
decisiones siguientes salieron de ahi y no de criterio.

- **El idioma vive en el dock, no en la cabecera.** Con el selector de idioma arriba, la cabecera
  ocupaba 93 px en **tres** filas a 1000 px, con la marca sola en la tercera, y el canal de texto se
  quedaba en 482 px. Bajandolo al dock, la cabecera cabe en **una** fila de 57 px y el canal sube a
  518. Son 36 px de texto recuperado, que es un 7 % de la ventana.
- **El menu de exportar NO entra en el dock.** Lleva el recuento de palabras, que cambia con cada
  bloque cerrado. Adentro de `DockedPlayer` pasaria a formar parte del subarbol que se repinta
  cuatro veces por segundo con la posicion del audio, y el historial entero se repintaria en cada
  avance de la cancion. El dock lleva solo el idioma, que cambia una vez cada varias frases: el
  criterio es "cambia con el audio o no", no "cabe en el dock".
- **La cabecera son tres grupos, no uno.** Con todo en un solo `flex-wrap`, el elemento con `ml-auto`
  (la marca) se caia a una tercera fila solo. `justify-between` con marca / captura / ajustes reparte
  el sobrante en vez de acumularlo delante del `ml-auto`, que es lo que lo empujaba al desborde.

**El boton de confirmar "Limpiar" va en un portal.** Es `position: fixed` y el `footer` que lo
contiene tiene `backdrop-blur`; cualquier ancestro con `backdrop-filter` se convierte en bloque
contenedor de los descendientes fijos, igual que `transform` y `filter`. Sin el portal, el fondo opaco
cubria una franja de 40 px pegada abajo y el recuadro salia centrado en ella: un boton flotando con su
sombra y sin modal alrededor. Es el mismo motivo y la misma solucion que el overlay de `DropZone`.

**El contador de frases sin leer se deriva, no se cuenta.** `TranscriptStream` guarda el **ancla** -el
numero de bloques que habia cuando el usuario se solto del final- y cuenta `blocks.length - anchor`
durante el render. Un contador de verdade tendria que incrementarse al llegar un bloque, y eso solo
se puede hacer desde un efecto: seria un `setState` por frase, que ademas pinta el historial entero
una vez mas. El ancla solo se mueve al **cruzar** el umbral, no en cada evento de scroll, o subir y
bajar un poco lo pondria a cero. `pruebas/estructural.mjs` prohibe que aparezca un `useEffect` en ese
fichero por este motivo.

**La cabecera de marca va solo en el Markdown.** El TXT sigue siendo texto plano y el SRT tiene
formato cerrado. `dateStamp` pasa por `Date` y no por `toISOString().slice(0, 16)`: este ultimo es UTC,
y con dos horas de diferencia la fecha del documento no cuadra con la del explorador. Una fecha
invalida sale `""` en vez de `NaN`, porque la cabecera no puede romper el export.

## El tema: `src/app/globals.css`

Dark Obsidian & Neon Amber, **dark por defecto** y sin `prefers-color-scheme`. La version anterior
conmutaba por el sistema y dejaba texto casi blanco sobre blanco, porque los componentes ya traian
clases `text-neutral-*` pensadas para fondo oscuro.

Los tokens de color estan en un `@theme inline`: superficies (`obsidian`, `panel`, `raised`), acentos
(`neon`, `flare`, `gold`), texto (`snow`, `slate-ink`, `ember`) y `olive` para el vumetro. Los nombres
existen para que un sitio no escriba `amber-500` y otro `orange-600` pensando que son lo mismo.
`inline` significa que Tailwind no emite la variable: mete el hex en cada utilidad que la usa. Un
token mal escrito no da error, simplemente no genera utilidad y la pantalla se queda sin color en
silencio; por eso `D:\Temp\opencode\check-css.js` verifica la hoja generada y no el source.

Cuatro reglas del tema que no se pueden deshacer, cada una con su motivo:

- **Lo que se anima es `transform` u `opacity`, nunca `height`, `width`, `top` ni `inset`.** El STT y
  la transcripcion ya compiten por el hilo principal; cualquier propiedad de disposicion en movimiento
  relayouta por su cuenta. Las barras del vumetro, el relleno del scrubber, el del volumen y el de la
  barra de descarga escalan con `scaleX`/`scaleY` en vez de medirse.
- **La asimetria del vumetro (subida instantanea, caida lenta) esta en `src/lib/vu.ts`, no en CSS.**
  Una transicion de CSS tiene una sola duracion y una sola curva, asi que **no puede** ser asimetrica, y
  poner dos `transform` en la misma declaracion no lo arregla: la segunda sustituye a la primera. El
  envolvente `max(nuevo, anterior * DECAY)` si lo puede, y es puro, asi que se ejercita con `node`.
- **`prefers-reduced-motion: reduce` apaga las animaciones continuas, no las suaviza.** `amber-pulse` y
  `equalizer-wave` son infinitas y en un angulo de la pantalla son justo el patron que molesta. El giro
  de la caratula se declara con `motion-safe:`, que ya lo envuelve solo. Las de una pasada (`fade-in`)
  se quitan tambien: con el bloque ya en su sitio final, animar su entrada no aporta nada.
- **Sin dependencias de animacion.** Solo Tailwind v4, CSS nativo y SVG en linea. Ni Framer Motion ni
  una libreria de iconos para dos triangulos.

`D:\Temp\opencode\check-css.js` comprueba la hoja de `.next/static`: que esten todos los tokens con su
hex, los seis keyframes, el bloque de reduced motion completo, y que no haya ninguna transicion de
disposicion. El giro de la caratula se comprueba aparte, porque `motion-safe:` lo envuelve en su propia
media query y no se ve en el mismo sitio que las nuestras.

## Los seis keyframes

`amber-pulse`, `cursor-glow`, `equalizer-wave` y `live-dot` son los continuos. Los dos de entrada son
**distintos a proposito** y no uno con dos nombres:

- `fade-in` mueve **6 px**: entradas cortas, desplegables y lineas de estado.
- `slide-up-fade` mueve **12 px**: la entrada de un bloque de texto cerrado en el canal.

Un bloque de frase completa necesita separarse mas del borde para que el ojo lo lea como algo nuevo y
no como una frase recolocada, y ese ritmo no le sirve a una etiqueta de 12 px. Si alguien "simplifica"
`slide-up-fade` a 6 px, no hay error: el CSS compila y la animacion sigue existiendo. Lo caza
`pruebas/estructural.mjs`, que compara las dos distancias y ademas prohibe cualquier propiedad de
disposicion dentro de un keyframe de entrada.

**Los dos van envueltos en `motion-safe:`.** En headless, `prefers-reduced-motion` sale `reduce` por
defecto, asi que una animacion mal envuelta no se ve NUNCA en una medicion por CDP: hay que emular
`no-preference` explicitamente para poder distinguir "no hay animacion" de "no la busques". El medidor
`D:\Temp\opencode\medir.mjs` mide las dos caras por eso.

## El reproductor: `src/lib/player/`

Cuatro ficheros, y la separacion es deliberada: `audioPlayer.ts` es el motor y no sabe nada de
React; `useMusicPlayer.ts` es el enlace; `types.ts` el contrato; `metadata.ts` un parser a mano.
Los componentes de `src/components/player/` **no importan el motor**, usan `useMusicControls`.

Decisiones que no se pueden deshacer sin motivo:

- **Un `HTMLAudioElement`, no Web Audio API.** Un `AudioContext` con `ScriptProcessorNode` o
  `AudioWorklet` pasa cada bloque de samples por el hilo principal, que es el mismo que renderiza
  la transcripcion. El `<audio>` deja el decodificador en el pipeline de multimedia del webview.
- **Singleton con estado fuera de React, notificado por `useSyncExternalStore`.** La posicion avanza
  cuatro veces por segundo; si estuviera en un `useState` de la pagina, se re-renderizaria el
  historial entero cuatro veces por segundo mientras se transcribe. Por eso hay dos hooks:
  `useMusicPlayer` (estado entero, solo el reproductor) y `useMusicPlaying` (booleano, para lo que
  solo necesita saber si suena).
- **`volume` es siempre el del usuario; la bajada por transcripcion es `isDucked`.** La primera
  version guardaba el volumen de antes de bajarlo y lo restauraba, y si el usuario movia el slider
  a media transcripcion se pisaban: al terminar la musica volvia a un volumen que nadie habia
  elegido. `applyVolume` decide, asi que las dos cosas no pueden entrar en conflicto.
- **El aleatorio se invalida, no se reconstruye a mano.** `setShuffle` y `reindex` dejan `order`
  vacio y que `buildOrder` lo rehaga poniendo la pista en curso la primera. La version anterior
  metia solo `[indiceActual]` en el orden, y con eso `nextIndex` se salia por el final y
  **"siguiente" paraba la musica**. Hay un caso en el banco que lo cubre.
- **Al quitar o vaciar la cola, `detach()` antes de `release()`.** Revocar el `objectURL` que tiene
  el elemento puesto produce un error de red espurio; `detach()` (pausar, quitar `src`, `load()`)
  es lo que suelta el decodificador nativo.
- **Reordenar con eventos de puntero, no con drag and drop de HTML5.** El navegador no distingue
  el arrastre de una fila del arrastre de un fichero, y con los dos montados soltar un `.mp3`
  encima de la fila intentaria moverla. Ademas hay botones de subir y bajar al lado.
- **`DropZone` escucha a `window`, y su overlay va en un portal.** El texto de la interfaz dice
  "suelta ficheros en la ventana", y con los eventos en un `<div>` que envuelve la barra inferior
  eso solo era cierto en los ultimos 60 px de la pantalla. El overlay va con `createPortal` a
  `document.body` porque cualquier ancestro con `transform`, `filter` o `backdrop-filter` convierte
  su `position: fixed` en relativo a ese ancestro, y el reproductor tiene `backdrop-blur` en sitios.
  El portal solo se monta con `hovering`, y `hovering` solo puede venir de un evento del navegador,
  asi que `document` no existe aun en el prerender y el primer render del cliente coincide con el del
  servidor: no hace falta estado de "montado" ni IIFE asincrono.
- **El parser de etiquetas es defensivo y sin dependencias.** `readTags` nunca lanza: cualquier
  excepcion es "sin metadatos", porque un reproductor que se cae al abrir una cancion es inservible
  y uno que muestra `cancion.mp3` sin caratula es usable. Ojo con el byte de codificacion de
  `APIC`, que va en la posicion 0: el byte de tipo de imagen va **despues** del MIME y no es el de
  codificacion.

Con loopback la musica del reproductor entra en la transcripcion, y **ponerse auriculares no lo
evita**: el loopback abre el endpoint de render con `AUDCLNT_STREAMFLAGS_LOOPBACK`, que es un grifo
digital sobre la mezcla antes del altavoz. El aviso de `captureConflict` dice exactamente eso, y sale
solo cuando hay captura activa y algo sonando.

## Marcadores, buscador y modo mini

Todas las piezas nuevas siguen la regla del repo: la logica comprobable va en `src/lib/` o en el crate
de abajo, y el componente solo la pega.

- **Marcadores.** `Block.bookmarked` es opcional, asi que `Persisted.version` sigue en `1` y una
  sesion guardada antes de este cambio se restaura igual. `toggleBookmark` vive en el reducer
  (`src/lib/transcript.ts`) y `bookmarkedBlocks` recibe la LISTA de bloques, no el estado entero.
  `Ctrl+B` marca la ultima frase; su id se lee de `blocks` en el momento del atajo y no de una
  referencia, para no marcar la penultima por un render viejo. El acento del bloque marcado usa los
  tokens del tema (`border-flare`, `bg-flare/[0.07]`), no la rampa cruda `amber-400` que se pidio
  literalmente: `AGENTS.md` ya explica que los tokens existen para que el ambar sea uno solo, y el
  banco estructural lo comprueba. En el Markdown van a una seccion `## Puntos Clave / Marcadores`
  ANTES de la transcripcion, con un ancla `<a id="bloque-N">` solo en las frases marcadas: emitirla
  en las 3000 frases de una reunion llenaria el fichero de `<a>` que nadie usa, y los demas bloques
  no son destino de ningun enlace.
- **Buscador.** `src/lib/search.ts` compara SUBCADENAS y nunca construye un `RegExp`:
  `new RegExp(texto, "gi")` es un ReDoS a pocos caracteres y corre en el mismo hilo que pinta la
  transcripcion, asi que un texto de busqueda raro congela la ventana entera. Normaliza con `NFD` y
  quita los diacriticos, de modo que `transcripcion` encuentra `transcripción`, y devuelve tramos
  para que el resaltado corte por el texto ORIGINAL. El campo vive en `SearchBar.tsx` y no dentro de
  `TranscriptStream`: el foco al abrir exige un `useEffect`, y ese fichero tiene **prohibido**
  cualquier efecto (el contador de frases sin leer se deriva del ancla). Con **texto escrito** se
  pinta el historial ENTERO y se salta la ventana de render: quien busca esta leyendo resultados, no
  scrolleando. Con el buscador abierto pero vacio se conserva la ventana, porque el recorte es
  invisible hasta que hay algo que buscar.
- **Ventana de renderizado.** Por encima de `LIMITE_RENDER` (150) `planVentana` pinta solo lo visible
  mas un margen y cubre el resto con DOS espaciadores de altura calculada, de modo que la altura
  total **no cambia nunca**. Colapsar el historial viejo seria mas barato, pero mueve el scroll y el
  usuario que lee la mitad veria saltar el texto bajo el cursor. El alto por bloque es una estimacion
  (56 px), asi que la barra de scroll puede no caer exactamente sobre la ultima frase; el contenido
  que se ve, si. El rango solo se publica como estado cuando cambia de verdad (`mismaVentana`).
- **Modo mini.** La geometria es de Rust: `mini_window.rs` en `lyricstream-asr` (funciones puras, 17
  tests) decide tamano, esquina y recorte contra la pantalla. Los comandos `toggle_mini_mode` y
  `get_mini_mode` viven en `src-tauri/src/commands.rs`; `SttState` guarda el estado en
  `src-tauri/src/stt.rs` y emite `mini-mode-changed` (`EVENT_MINI_MODE`). La UI **no** decide el modo
  ni redimensiona la ventana: lee `get_mini_mode` al montar, escucha el evento y pinta
  `MiniOverlay.tsx` o la maqueta normal, nunca las dos. El nombre del evento esta escrito en
  TypeScript y en Rust, y un test estructural compara las dos cadenas: un cambio en uno y no en el
  otro no da error de compilacion (la ventana encogeria y la UI se quedaria en grande).

# Pendiente conocido

`EngineStatus.real_inference` sale de `EngineInfo::ready`, no de un literal. Cuando el runtime no
esta desplegado, `build_engine` devuelve un `WhisperEngine` con `ready = false` y el motivo en
`detail`; **no** se cae a `StubEngine`, porque un doble que produce texto con formato de demo
daria una transcripcion que parece funcionar y no transcribe. `StubEngine` sigue existiendo para
los tests del pipeline, que lo inyectan por `SttWorker::start`.

La UI no decide si el modelo sirve: usa `ModelInfo.installed && size_ok && (expected_sha256 === null
|| verified)`, que es el mismo criterio que `ModelInfo::is_usable` en Rust. No reimplementar aqui la
comparacion de hashes.

# Comandos de verificacion

```powershell
npm run lint                     # incluye las reglas de React Compiler, en modo error
npm run build
npm run test:estructural         # 17 tests sobre el fuente de los componentes y de Rust
npm run test:mutacion            # comprueba que esos 17 tests FALLAN sobre el codigo roto
cargo fmt --all --check --manifest-path src-tauri\Cargo.toml   # 2 espacios, ancho 100
cargo check --all-targets --manifest-path src-tauri\Cargo.toml
cargo test --manifest-path src-tauri\Cargo.toml                 # 118 tests
```

## Lo que el banco temporal **no** caza, y `pruebas/` si

No hay runner de tests en el frontend y **no se anade uno**: `reduce`, los exportadores y el motor
del reproductor se verifican compilando `src/lib` con `npx tsc --outDir` a un directorio temporal y
ejecutando un banco de casos con `node`. La logica pura esta aislada en `src/lib/` justamente para
que eso sea posible sin arrastrar React ni Tauri. El banco del reproductor necesita stubs de
`Audio`, `URL.createObjectURL` y `localStorage`, porque el motor solo crea el elemento en el primer
comando; el `FakeAudio` tiene que disparar `play` y `pause`, que es lo que el motor escucha. El del
vumetro (`runvu.js`) es el que mas ha encontrado: la asimetria del envolvente no es comprobable viendo
la barra, porque un `max` mal puesto tambien "parece" funcionar.

Ese banco **no entra en el repo** (su propia cabecera lo dice) y por eso no protege nada: se
recompila a mano y se pierde en el siguiente build limpio. Es una herramienta de busqueda, no una
red de seguridad. Los tres bugs del vumetro que se encontraron midiendo la ventana con CDP
demonstran el limite: **`vu.ts` era correcto en los tres**, el fallo estaba en el punto de llamada,
dentro de un componente React que el banco no monta.

`pruebas/estructural.mjs` cubre ese hueco y **si** se commitea, porque un test que se borra no
previene una regresion. No es un runner: es `node` puro, sin dependencias, sin transformacion y sin
jsdom, y lee el texto de `src/` (componentes, `src/lib` y `src-tauri/src/stt.rs`) con `node:fs`.
Comprueba cosas que no se ven ejecutando `vu.ts`:

- Que `vuBarScale` no se pase **desnuda** a `.map()`. El bug era de aridad en el punto de llamada:
  `map` invoca con `(valor, indice, array)` y el segundo parametro de `vuBarScale` es `floor`, asi
  que el indice se colaba como suelo y la fila salia `scaleY(0)..scaleY(47)`. Un test de valores
  no lo ve, porque los valores que pasaban eran validos.
- Que la firma de `vuBarScale` **conserve** `floor`. Sin esta comprobacion, "arreglar" el bug
  quitando el segundo parametro haria desaparecer la fuga por el motivo equivocado.
- Que la fila tenga siempre `LEDS` barras y no las que lleva el historial ya llenado.
- Que el `min-w` del grupo de la pista de al menos lo que necesitan 48 barras de 1 px, sus 47
  huecos `gap-px`, su relleno `p-0.5`, el `gap-3` del grupo y el `w-14` de la lectura dB. Con
  51 px medidos en vivo, los 47 huecos se comian 47 y cada barra salia a 0 px de dispositivo.
- Que ni la pista ni las barras dejen de ser `flex-1`, que es lo que reparte el ancho.
- Que el timestamp no vuelva a llevar un modificador de opacidad sobre `text-flare`.
- Que el buscador no construya un `RegExp` (ReDoS en el hilo de pintado) y siga comparando
  subcadenas con `indexOf`.
- Que el acento del bloque marcado use los tokens del tema y no la rampa cruda `amber-*`.
- Que la ventana pinte los DOS espaciadores de altura y que los dos vayan `aria-hidden`. Sin ellos
  la altura total se colapsa y el scroll salta al cerrarse un bloque.
- Que `EVENTS.miniMode` (TypeScript) y `EVENT_MINI_MODE` (Rust) sean la misma cadena. Un renombrado
  en un solo lado no da error de compilacion: la ventana encoge y la UI se queda en grande.
- Que el atajo de teclado ceda el paso en los campos de texto (`isContentEditable`, `INPUT`,
  `TEXTAREA`).
- Que el modo mini lo decida el backend: la pagina llama a `toggle_mini_mode` y `get_mini_mode` y no
  redimensiona la ventana por su cuenta (`setSize`/`LogicalSize`).

**`pruebas/mutacion.mjs` es la parte que no se puede saltar.** Pasa el codigo bueno, y un test que
solo pasa no demuestra nada. El script copia `src/` (y `src-tauri/src/stt.rs`, que un test cruza con
TypeScript) a un temporal, aplica cada una de las veintiuna regresiones que ya ocurrieron **en la
forma en que ocurrieron**, ejecuta `estructural.mjs` contra la copia rota y exige que FALLE. Las
veintiuna tienen que morir. Si alguna sobrevive, ese test no vigilaba lo que dice vigilar. La primera vez que se ejecuto aviso de que una mutacion no aplicaba: la firma
de `vuBarScale` era `floor: number = FLOOR` y la mutacion se habia escrito con otra forma. Es
justo el fallo que este banco existe para encontrar, y por eso esta en el repo y no en el temporal.

`estructural.mjs` acepta la raiz como argumento solo para eso: `node pruebas/estructural.mjs
D:\copia` apunta los tests a otra copia de `src/`, que es lo que permite mutar sin editar el repo.


`cargo test` sin el runtime desplegado omite 15 tests de inferencia real (7 del sys, 8 de
streaming) y pasa los demas. Con `scripts\deploy-whisper.ps1` ejecutado, pasan todos.

Los tests que cargan el modelo **se serializan solos**, con un `Mutex` por binario de test: cada
uno abre su propio contexto de whisper (~130 MB) y siete a la vez no caben en la RAM de este
equipo. Sin ese cerrojo `cargo test` muere con `STATUS_STACK_BUFFER_OVERRUN` (0xC0000409). Por eso
`preparado!`/`runtime_o_model!` devuelven tambien el cerrojo, envuelto en un `Drop` que suelta el
contexto ANTES de liberar el cerrojo: Rust destruye las variables locales en orden inverso al de
declaracion y, sueltos por separado, el cerrojo se abriria antes de que el motor soltase la
memoria. Un test **no** puede llamar dos veces a `preparado!`: `Mutex` no es reentrante y se
quedaria colgado (por eso `whisper_stream.rs` comprueba el hilo con un `thread_local!`).

`next build` genera el export estatico en `out/`, que es lo que Tauri carga (`frontendDist`).

# Empaquetado

`tauri.conf.json` copia `crates/lyricstream-whisper-sys/runtime/*.dll` a `whisper/` dentro del
bundle. Las DLL estan en `.gitignore`, asi que **`scripts\deploy-whisper.ps1` tiene que correr
antes de `npm run tauri build`**: sin el runtime desplegado, el build falla al no encontrar los
recursos. `jfk.wav` no se empaqueta: solo lo usan los tests.
