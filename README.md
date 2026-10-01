# LyricStream STT

> Transcripción de voz en tiempo real 100% local con reproductor integrado · Hecho por GLL

[![Release](https://img.shields.io/github/v/release/Lol-bit-Rvgl/GLL-Project1?label=release&color=ffb000)](https://github.com/Lol-bit-Rvgl/GLL-Project1/releases/latest)
[![Build](https://github.com/Lol-bit-Rvgl/GLL-Project1/actions/workflows/build.yml/badge.svg)](https://github.com/Lol-bit-Rvgl/GLL-Project1/actions/workflows/build.yml)
[![License](https://img.shields.io/github/license/Lol-bit-Rvgl/GLL-Project1?label=license&color=ffb000)](./LICENSE)
[![Installer](https://img.shields.io/badge/installer-~5.9_MB-ffb000)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-ffb000)]()
[![Target](https://img.shields.io/badge/target-x86__64--pc--windows--gnu-ffb000)]()

**LyricStream STT** es una aplicación de escritorio para Windows que transcribe voz en
tiempo real **sin enviar ni un byte a la nube**. Todo el reconocimiento de voz corre en tu
máquina con [whisper.cpp](https://github.com/ggml-org/whisper.cpp), y viene con un
reproductor de audio integrado pensado para tomar apuntes mientras escuchas: la música se
atenúa automáticamente cuando alguien habla, y las frases quedan marcadas, buscables y
exportables al instante.

## Características principales

- **100% local y privado.** Inferencia *offline* con whisper.cpp (`b5130`) y el modelo
  cuantizado `ggml-tiny-q5_1.bin` (~30.7 MB). Cero telemetría y cero dependencias en la
  nube: la única conexión de red es la descarga inicial del modelo, verificada contra su
  SHA-256.
- **Captura dual.** Loopback de audio del sistema (WASAPI) o entrada de micrófono,
  reducida a **16 kHz mono** mediante downmix y un filtro FIR anti-alias de 127 taps con
  estado entre bloques.
- **Reproductor con *ducking* inteligente.** Durante el habla, el volumen del reproductor
  cae automáticamente para no contaminar la captura, y al terminar se restaura exactamente
  el volumen que eligió el usuario (nunca uno intermedio).
- **Productividad.**
  - Marcadores en vivo (`Ctrl+B`) exportables con anclas navegables.
  - Buscador diacrítico instantáneo (normaliza con NFD: `transcripcion` encuentra
    `transcripción`).
  - Modo mini-*overlay* flotante `always_on_top`.
  - Exportación a **TXT**, **Markdown** (con firma GLL y sección de marcadores) y **SRT**.
- **Interfaz "Obsidian & Amber".** WebView2 con composición en GPU, vúmetro balístico con
  envolvente asimétrico (ataque instantáneo, caída suave) y renderizado virtualizado para
  sesiones largas (por encima de 150 bloques solo se pinta lo visible).

## Requisitos del sistema

| Requisito | Detalle |
| --- | --- |
| Sistema operativo | Windows 10 / 11 x64 |
| Memoria | ~8 GB de RAM recomendados |
| WebView2 | Incluido en Windows 10/11 modernos |
| Red | Solo la primera vez, para descargar el modelo (~30.7 MB) |

## Instalación rápida

1. Entra en la sección de **[Releases de GitHub](https://github.com/Lol-bit-Rvgl/GLL-Project1/releases/latest)**.
2. Descarga el instalador `LyricStream.STT_0.1.0_x64-setup.exe` (~5.9 MB).
3. Ejecútalo y sigue el asistente NSIS.
4. En el primer arranque, la app descargará el modelo de voz y verificará su integridad.

> **Nota:** el instalador no incluye los pesos de Whisper (son un fichero aparte). La
> aplicación los descarga una sola vez y los guarda en tu disco.

## Atajos de teclado

| Atajo | Acción |
| --- | --- |
| `Ctrl`/`Cmd` + `B` | Marca o desmarca el **último** bloque transcrito |
| `Ctrl`/`Cmd` + `F` | Abre o cierra el buscador diacrítico |
| `Esc` | Cierra el buscador o la cola de reproducción |
| `←` / `→` (scrubber) | Retrocede / avanza 5 s (`Shift` para 30 s) |
| `Home` / `End` (scrubber) | Salta al inicio / final de la pista |
| `Espacio` / `Enter` (scrubber) | Confirma la posición mostrada |
| `↑` `↓` `←` `→` (volumen) | Ajusta el volumen un 5% (`Shift` para 25%) |
| `Home` / `End` (volumen) | Silencio / volumen máximo |

## Arquitectura y stack

El proyecto son **cuatro crates de Rust** con la dependencia apuntando hacia abajo, más un
frontend de **Next.js 16** servido como export estático dentro de una ventana de **Tauri v2**.

```text
 Micrófono / Loopback WASAPI
          │  (cpal, f32)
          ▼
   Downmix mono ─► FIR anti-alias ─► Remuestreo 16 kHz
          │
          ▼
     Ring buffer (sin bloqueos)
          │
          ▼
   SttWorker ─► VAD ─► Segmenter ─► WhisperEngine ─► eventos Tauri
                                                       │
                                                       ▼
                                          UI + export TXT / MD / SRT
```

| Componente | Responsabilidad |
| --- | --- |
| `lyricstream-stt` (raíz) | Capa Tauri: comandos, estado (`SttState`) y eventos. Solo pega las piezas. |
| `lyricstream-asr` | VAD, segmentación, worker de inferencia, gestión de pesos, `WhisperEngine` y geometría del modo mini. |
| `lyricstream-audio` | Captura cpal/WASAPI, downmix y remuestreo anti-alias a 16 kHz mono. Sin Tauri. |
| `lyricstream-whisper-sys` | Puente C (`shim.c`) a whisper.cpp, cargado en tiempo de ejecución con `LoadLibraryExW`. |
| Frontend | Next.js 16.3 (export estático) + React 19 + Tailwind CSS 4. |
| Runtime de inferencia | whisper.cpp `b5130` + backend de CPU `ggml` (DLLs). |

La lógica comprobable vive en los crates de abajo (audio, ASR) y en `src/lib/`, de modo que
se puede testear sin levantar la ventana de Tauri ni React.

## Compilación desde el código

Requisitos de desarrollo: **Node.js 20+**, **Rust** (toolchain `x86_64-pc-windows-gnu`) y
**MinGW GCC 13+**.

```powershell
# 1. Dependencias del frontend
npm install

# 2. Runtime de whisper.cpp (DLLs, ~12 MB) — necesario antes de empaquetar
powershell -ExecutionPolicy Bypass -File scripts\deploy-whisper.ps1

# 3. Desarrollo en el navegador (vista previa, sin Tauri)
npm run dev

# 4. Instalador NSIS de producción
npm run tauri build
```

Verificación:

```powershell
npm run lint
npm run test:estructural
npm run test:mutacion
cargo test --manifest-path src-tauri\Cargo.toml
```

## Licencia

Distribuido bajo la licencia **MIT**. Consulta el fichero [LICENSE](./LICENSE) para más
detalle. whisper.cpp se distribuye bajo su propia licencia (véase
`src-tauri/crates/lyricstream-whisper-sys/vendor/whisper/LICENSE-whisper.cpp`).

---

Hecho con ♥ por **GLL**.
