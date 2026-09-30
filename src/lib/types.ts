/**
 * Espejo de las estructuras `Serialize` del lado Rust.
 *
 * Se redeclaran a proposito, en vez de importar un paquete compartido: son cinco
 * objetos, el contrato ya lo fija `cargo test` en Rust, y duplicarlos hace que un
 * cambio de campo se note aqui en vez de colarse en un `undefined` silencioso.
 *
 * # OJO: los nombres van EN SNAKE_CASE, y no es una mania
 *
 * Serde serializa el nombre del campo tal cual esta declarado, salvo que el `derive`
 * lleve `#[serde(rename_all = "camelCase")]`. Aqui el reparto es irregular, asi que
 * esta fichero mezcla las dos convenciones a proposito:
 *
 * - SIN `rename_all` (snake_case en el JSON): `TranscriptionSegment`, `WorkerStats`,
 *   `EngineStatus`, `ModelInfo` y `ModelStatus`.
 * - CON `rename_all = "camelCase"`: `DownloadProgress`, `DownloadOutcome`,
 *   `CaptureStatus`, `AudioDeviceInfo` y `AudioDevicesInfo`.
 *
 * Los de camelCase casan por casualidad (sus campos son de una sola palabra), pero
 * `CaptureStatus` y `AudioDevicesInfo` de verdad mandan `inputSampleRate` y
 * `defaultInput`. Estos tipos no se "arreglan" desde aqui: si un dia se quiere una
 * sola convencion, lo correcto es poner `rename_all = "camelCase"` en el `derive` de
 * Rust y actualizar el espejo, no traducir en el lado de la UI, porque entonces el
 * contrato de los eventos dejaria de coincidir con el que ven los tests.
 *
 * # Campos que ya no existen
 *
 * La version anterior declaraba `index`, `endMs` y `language` en el segmento, y
 * `TranscriptionSegment` en `worker.rs` no tiene ninguno de los tres. Los tres
 * valian `undefined` en tiempo de ejecucion. El indice se genera en la UI, y el fin
 * del segmento se calcula sumando `duration_ms`: no hace falta que Rust lo mande.
 *
 * En cambio Rust si manda `confidence`, que aqui no estaba. Como whisper.cpp no
 * expone confianza por token a traves del shim, el valor llega siempre en 0, que
 * la UI trata como "desconocido" en vez de "certeza cero".
 */

/** Estado de los pesos en disco. `Serialize` sin `rename_all`. */
export type ModelInfo = {
  name: string;
  file_name: string;
  expected_path: string;
  installed: boolean;
  size_bytes: number;
  expected_sha256: string | null;
  actual_sha256: string | null;
  verified: boolean;
  size_ok: boolean;
};

/** Contadores del worker de inferencia. `Serialize` sin `rename_all`. */
export type WorkerStats = {
  frames: number;
  inferences: number;
  segments: number;
  discarded: number;
  errors: number;
  noise_floor_db: number;
  speaking: boolean;
};

/** Estado del motor de inferencia. `Serialize` sin `rename_all`. */
export type EngineStatus = {
  running: boolean;
  engine: string;
  /** `false` mientras el runtime nativo no se haya podido cargar. */
  real_inference: boolean;
  detail: string;
  language: string;
  speaking: boolean;
  stats: WorkerStats;
};

/** Estado conjunto que devuelve `get_model_status`. `Serialize` sin `rename_all`. */
export type ModelStatus = {
  model: ModelInfo;
  engine: EngineStatus;
  downloading: boolean;
  models_dir: string;
};

/**
 * Progreso de descarga del modelo. `Serialize` con `rename_all = "camelCase"`.
 *
 * Los tres campos son de una sola palabra, asi que el `rename_all` no cambia nada
 * aqui. Se deja anotado para que nadie lo "corrija" a `downloaded_bytes`.
 */
export type DownloadProgress = {
  downloaded: number;
  total: number | null;
  percent: number | null;
};

/** Como termino una descarga. `rename_all = "camelCase"`, tambien irrelevante. */
export type DownloadOutcome = {
  ok: boolean;
  error: string | null;
  model: ModelInfo | null;
};

/** Un fragmento de transcripcion, tal y como lo emite el worker. Sin `rename_all`. */
export type TranscriptionSegment = {
  /**
   * Solo el INCREMENTO desde el parcial anterior, no la ventana entera.
   *
   * La UI concatena, asi que devolver la ventana completa repetiria la frase en
   * pantalla. Es el contrato que fija `WhisperEngine::increment` y que comprueba
   * `whisper_stream.rs`.
   */
  text: string;
  is_final: boolean;
  /** Siempre 0 con whisper.cpp; la UI lo trata como desconocido. */
  confidence: number;
  /** Desfase del segmento respecto al inicio del flujo, en ms. */
  start_ms: number;
  /** Duracion de la ventana entregada al motor, en ms. */
  duration_ms: number;
};

/**
 * Estado de la captura. `rename_all = "camelCase"`: aqui SI cambia el nombre.
 */
export type CaptureStatus = {
  running: boolean;
  paused: boolean;
  source: AudioSource | null;
  inputSampleRate: number | null;
  inputChannels: number | null;
  outputSampleRate: number;
  droppedSamples: number;
};

/** Un dispositivo de audio. `rename_all = "camelCase"`. */
export type AudioDevice = {
  index: number;
  name: string;
  isDefault: boolean;
};

/** Dispositivos de entrada y salida, con cual es el de por defecto. */
export type AudioDevicesInfo = {
  outputs: AudioDevice[];
  inputs: AudioDevice[];
  defaultInput: string | null;
  defaultOutput: string | null;
};

/** Origen de la captura. */
export type AudioSource = "loopback" | "mic";

/** Idioma forzado, o deteccion automatica. */
export type Language = "auto" | "es" | "en";

/** Fase del ciclo de vida, para el indicador de la barra de control. */
export type EnginePhase = "reposo" | "capturando" | "transcribiendo";

/**
 * Estado del modo mini-ventana. `rename_all = "camelCase"` en el derive de Rust.
 *
 * Un solo campo, asi que la convencion no se nota, pero se deja escrito porque el dia
 * que se anada el segundo (`width`, `height`) la diferencia entre `snake_case` y
 * `camelCase` si se ve.
 */
export type MiniModeStatus = {
  active: boolean;
};

/** Nombres de los eventos que emite el backend. */
export const EVENTS = {
  download: "model-download-progress",
  downloadResult: "model-download-result",
  transcription: "transcription-segment",
  engine: "stt-engine-status",
  miniMode: "mini-mode-changed",
} as const;
