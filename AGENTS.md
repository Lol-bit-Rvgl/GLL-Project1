<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Entorno

Antes de `cargo` o `npm run tauri`, hay que poner esto en el `PATH` de la sesion:

```powershell
$env:CARGO_HOME="D:\Rust\cargo"; $env:RUSTUP_HOME="D:\Rust\rustup"
$env:PATH="$env:PATH;D:\Rust\mingw64\mingw64\bin;D:\Rust\cargo\bin"
```

Sin esto, `cargo` no aparece: Rust no esta en el PATH del sistema.

Restricciones del equipo: ~1 GB de RAM, target `x86_64-pc-windows-gnu`, MinGW GCC 16.2.
`.cargo/config.toml` deja `jobs = 2`, `debug = 0` e `incremental = false` por eso. Compilar en
`--release` tarda ~12 min; no es un error, es el objetivo por defecto. **No añadir dependencias
grandes** (`reqwest`, `ort`, `whisper`, crates de criptografia): es justo lo que revienta la
maquina. Ver "Descargas" mas abajo.

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
evita compilar TLS en un equipo con 1 GB de RAM. Cambiar de cliente HTTP significa implementar
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

`page.tsx` hace `setSegments(prev => [...prev, ...])`: cada evento se **anya**, no se sustituye. Por
eso `WhisperEngine` devuelve solo el **incremento** respecto a lo ya emitido, calculado por
palabras completas. Devolver la ventana entera repetiria la frase en pantalla. La UI no tiene forma
de decir "borra lo anterior", asi que una palabra que whisper revierte se queda.

Los primeros parciales son **ruidosos por naturaleza**: con 1 s de audio whisper alucina
(`[INAUDIBLE]`, "you are country"). El final, con el utterance completo, es fiable. Se eligio
parciales rapidos y ruidosos antes que parciales utiles a los 2-3 s. Ver el doc de
`whisper_engine.rs` con las salidas medidas.

# Pendiente conocido

`EngineStatus.real_inference` sale de `EngineInfo::ready`, no de un literal. Cuando el runtime no
esta desplegado, `build_engine` devuelve un `WhisperEngine` con `ready = false` y el motivo en
`detail`; **no** se cae a `StubEngine`, porque un doble que produce texto con formato de demo
daria una transcripcion que parece funcionar y no transcribe. `StubEngine` sigue existiendo para
los tests del pipeline, que lo inyectan por `SttWorker::start`.

# Comandos de verificacion

```powershell
cargo fmt --all --check        # 2 espacios, ancho 100
cargo check --all-targets
cargo test                     # 101 tests
npm run lint
npm run build
```

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
