/**
 * Puente entre la UI y el runtime: Tauri de verdad, o stubs en el navegador.
 *
 * # Por que existe, y por que es UN solo fichero
 *
 * `@tauri-apps/api` llama a `window.__TAURI_INTERNALS__.invoke`. Sin ese objeto -es decir,
 * en Chrome, en Edge, en Firefox, sirviendo `out/` por HTTP- la llamada lanza
 * `TypeError` dentro de una funcion `async`, o sea que vuelve como promesa rechazada. Un
 * `listen` rechazado en el efecto de montaje deja el componente entero sin datos y con un
 * error en consola; un `invoke` rechazado pone su mensaje en la barra de errores de la
 * pagina, que es donde el usuario ve "Cannot read properties of undefined (reading
 * 'invoke')". Nada de eso es un fallo de la app: es la app de escritorio vista desde un
 * sitio donde no puede existir.
 *
 * Todo lo que habla con Tauri pasa por aqui, y en ningun otro sitio se importa
 * `@tauri-apps/api`. Importarlo en tres sitios significa tres sitios donde decidir que
 * hacer sin Tauri, y el que se olvide es el que rompe. `pruebas/estructural.mjs` lo
 * comprueba.
 *
 * # Que se simula y que no
 *
 * Se simulan SOLO las lecturas (`get_stt_status`, `get_model_status`,
 * `get_capture_status`, `get_audio_level`, `get_mini_mode`). Dan un estado honesto: motor
 * parado, sin inferencia, sin modelo, sin captura.
 *
 * NO se simulan las escrituras (`start_capture`, `start_stt`, `download_model`,
 * `toggle_mini_mode`): devolver un exito ahi pondria "Transcribiendo en vivo" en la
 * cabecera sin que haya nada transcribiendo, que es el fallo que la propia barra de
 * control declara el peor posible. Esos comandos rechazan con un mensaje que lo dice, y
 * sus botones estan desactivados mientras no hay Tauri (`web` en `ControlBar`).
 *
 * # El bus de eventos
 *
 * `emitir` es el otro extremo: en modo web los eventos se generan aqui, en memoria. Es lo
 * que permite ejercitar el reducer, el buscador, los marcadores y los exportadores sin
 * backend, y lo hace por el camino real -los mismos eventos que emitiria Rust-, no
 * metiendo bloques a mano en el estado.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

import type {
  CaptureStatus,
  EngineStatus,
  MiniModeStatus,
  ModelStatus,
  WorkerStats,
} from "./types";

/** Lo que devuelve `listen` para cortar la suscripcion. */
export type UnlistenFn = () => void;

/** El sobre de un evento, igual que en Tauri. */
export type Evento<T> = { payload: T };

/**
 * `true` si la pagina corre dentro del runtime de Tauri.
 *
 * El objeto que lo decide lo inyecta el shell nativo antes de cargar la webview. En un
 * navegador normal no existe, y ahi es donde se decide el modo web.
 *
 * Es una FUNCION y no una constante de modulo a proposito: el export estatico se genera
 * en el servidor, donde `window` no existe, y una constante evaluada al importar el
 * modulo se quedaria con el valor del servidor para toda la vida del proceso del
 * navegador.
 */
export function hayTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Estado del motor en el navegador.
 *
 * `real_inference: false` y `detail` con el motivo: la UI ya tiene el aviso de "no se
 * transcribe de verdad", y en vez de suprimirlo en modo web se le da la razon correcta.
 * Un motor que se hace pasar por real en la vista previa seria el mismo fallo que el
 * `StubEngine` de Rust, que existe solo para tests.
 */
export function estadoWeb(): EngineStatus {
  return {
    running: false,
    engine: "Vista previa",
    real_inference: false,
    detail: "Modo Web / Vista Previa",
    language: "auto",
    speaking: false,
    stats: { ...VACIO },
  };
}

/**
 * Estado del modelo en el navegador.
 *
 * `installed: false` a proposito, aunque asi la cabecera ofrezca "Descargar modelo": el
 * boton se desactiva en modo web y explica que no hay modelo que descargar. Marcarlo
 * como instalado seria la unica forma de esconderlo, y seria mentira.
 */
function estadoModeloWeb(): ModelStatus {
  return {
    model: {
      name: "(sin modelo en el navegador)",
      file_name: "",
      expected_path: "",
      installed: false,
      size_bytes: 0,
      expected_sha256: null,
      actual_sha256: null,
      verified: false,
      size_ok: false,
    },
    engine: estadoWeb(),
    downloading: false,
    models_dir: "(navegador)",
  };
}

const VACIO: WorkerStats = {
  frames: 0,
  inferences: 0,
  segments: 0,
  discarded: 0,
  errors: 0,
  noise_floor_db: -90,
  speaking: false,
};

type Stub = (args?: Record<string, unknown>) => unknown;

/**
 * Comandos que responden sin Tauri.
 *
 * Un objeto literal y no un `switch`: la lista se lee de un vistazo, y anadir un comando
 * es anadir una linea en vez de tocar un flujo de control. Los que no estan aqui
 * rechazan.
 */
const STUBS: Record<string, Stub> = {
  get_stt_status: () => estadoWeb(),
  get_model_status: () => estadoModeloWeb(),
  get_capture_status: (): CaptureStatus => ({
    running: false,
    paused: false,
    source: null,
    inputSampleRate: null,
    inputChannels: null,
    outputSampleRate: 48_000,
    droppedSamples: 0,
  }),
  get_mini_mode: (): MiniModeStatus => ({ active: false }),
  // El vumetro se queda a cero en vez de hide: no hay captura, y un nivel inventado
  // seria un vumetro mentiroso.
  get_audio_level: () => 0,
  // Cambiar el idioma no hace nada porque no hay motor, pero el selector del dock
  // sigue siendo util para el idioma que se imprime al exportar.
  set_stt_language: () => null,
};

/**
 * Llama a un comando del backend, o al stub que lo representa en el navegador.
 *
 * Misma firma que `invoke` de Tauri, y el error sigue siendo una promesa rechazada: los
 * llamantes ya tratan con `.catch`, y los que no, deben enterarse.
 */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (hayTauri()) return tauriInvoke<T>(cmd, args);
  const stub = STUBS[cmd];
  if (stub === undefined) {
    return Promise.reject(
      new Error(`Modo web: "${cmd}" no existe fuera de la app de escritorio.`),
    );
  }
  return Promise.resolve(stub(args) as T);
}

type Handler = (event: Evento<unknown>) => void;

const suscriptores = new Map<string, Set<Handler>>();

/**
 * Se suscribe a un evento del backend, o al bus en memoria del navegador.
 *
 * En modo web devuelve una `Promise` resuelta con la funcion de baja, nunca una
 * rechazada: los llamantes montan la lista de suscripciones en el cuerpo del efecto y
 * solo las cancelan al desmontar, asi que un rechazo aqui llegaria a la consola como
 * "unhandled rejection" sin que nadie lo llegue a ver.
 */
export function listen<T>(event: string, handler: (event: Evento<T>) => void): Promise<UnlistenFn> {
  if (hayTauri()) return tauriListen<T>(event, handler);
  let grupo = suscriptores.get(event);
  if (grupo === undefined) {
    grupo = new Set<Handler>();
    suscriptores.set(event, grupo);
  }
  const alvo = handler as Handler;
  grupo.add(alvo);
  return Promise.resolve(() => {
    grupo.delete(alvo);
  });
}

/**
 * Emite un evento al bus del navegador. Sin efecto con Tauri.
 *
 * Se recorre una COPIA del conjunto: un manejador que se da de baja dentro del evento
 * modificaria el conjunto que se esta recorriendo. `Set` no falla al borrarse a si
 * mismo durante la iteracion, pero saltarse un manejador al borrar otro si.
 */
export function emitir<T>(event: string, payload: T): void {
  const grupo = suscriptores.get(event);
  if (grupo === undefined) return;
  for (const handler of [...grupo]) handler({ payload });
}