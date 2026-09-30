/**
 * Motor de reproduccion: un `HTMLAudioElement` y poco mas.
 *
 * # Por que un `<audio>` y no Web Audio API
 *
 * Es la decision que sostiene el requisito de "que la musica no entorpezca al STT".
 * Un `AudioContext` con `ScriptProcessorNode` o `AudioWorklet` obliga a que cada
 * bloque de samples pase por el hilo principal de JavaScript, que es el mismo que
 * renderiza la lista de transcripcion y despacha los eventos de whisper. Con una
 * pista larga, eso se nota como tirones en el texto.
 *
 * `HTMLAudioElement` delega el decodificador y el mezclador al pipeline de multimedia
 * del webview, que corre en otros hilos. La reproduccion no toca el hilo de React.
 * Ademas, el pipeline nativo de captura de Rust es un hilo del proceso de Tauri, no
 * del webview: no hay recurso compartido que el reproductor pueda agotar.
 *
 * Un solo elemento para toda la app, creado perezoso: crear uno por pista deja
 * decodificadores vivos hasta que el elemento es recolectado, y en una cola larga eso
 * es memoria quemada sin ninguna advertencia.
 *
 * # Estado
 *
 * El estado vive aqui, fuera de React, y se notifica por suscripcion. Motivo: la
 * posicion avanza cuatro veces por segundo, y si estuviera en un `useState` del
 * componente raiz, la pagina entera se re-renderizaria cuatro veces por segundo
 * mientras se transcribe. Los hooks (`useMusicPlayer`, `useMusicPlaying`) eligen que
 * parte les interesa.
 *
 * # Instancia unica
 *
 * El modulo es un singleton, no una clase que se instancie: dos Reproductores
 * compartiran un `<audio>` y se pisarian el `src` en mitad de la reproduccion. La
 * instancia se crea en el primer comando, no al importar, para que importar este
 * fichero en el servidor no toque `document`.
 */

import { EMPTY_PLAYER_STATE } from "./types";
import type { PlayerState, RepeatMode, Track } from "./types";

type Listener = (state: PlayerState) => void;

let element: HTMLAudioElement | null = null;
let state: PlayerState = { ...EMPTY_PLAYER_STATE };
const listeners = new Set<Listener>();

/** Orden de reproduccion cuando hay aleatorio: indices dentro de `state.queue`. */
let order: number[] = [];
let orderAt = 0;

/** `true` si el usuario pidio silencio por el boton, no por la opcion de transcribir. */
let userMuted = false;

/** Suspension pedida por "silenciar mientras transcribo". No toca `state.volume`. */
let ducked = false;

/**
 * Preferencias que sobreviven a la sesion.
 *
 * Solo el volumen y el modo de repeticion. La cola **no** se guarda: sus
 * `objectURL` caducan al recargar la pagina, y una cola con URLs muertas es un
 * reproductor que no reproduce nada y ademas ocupa sitio.
 */
const PREF_KEY = "lyricstream:player";
let prefsRestored = false;

// ---------------------------------------------------------------------------
// Estado y suscripcion
// ---------------------------------------------------------------------------

export function getState(): PlayerState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(patch: Partial<PlayerState>): void {
  let changed = false;
  for (const key of Object.keys(patch) as (keyof PlayerState)[]) {
    if (!Object.is(state[key], patch[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

// ---------------------------------------------------------------------------
// Elemento de audio
// ---------------------------------------------------------------------------

/**
 * El `<audio>`, creado la primera vez.
 *
 * `preload="metadata"` es lo que permite conocer la duracion sin bajarse la pista
 * entera. Con `preload="auto"` de una URL remota, abrir una cola de diez enlaces
 * descargaria las diez; con `metadata`, solo las cabeceras.
 */
function audio(): HTMLAudioElement {
  if (element !== null) return element;
  const node = new Audio();
  node.preload = "metadata";
  // Solo se pone para streams de otra pagina: un `AudioContext` no puede analizar
  // muestras de un origen sin CORS. Para ficheros locales es irrelevante, y si un
  // stream no lo permite el navegador lo avisa en consola, que es el sitio correcto.
  node.crossOrigin = "anonymous";
  wireEvents(node);
  element = node;
  restorePrefs();
  applyVolume(node);
  return node;
}

/**
 * Recupera volumen y repeticion guardados.
 *
 * Se llama desde `audio()`, o sea en el primer comando del usuario, nunca al importar
 * el modulo: eso permite importar este fichero durante el prerender de Next sin tocar
 * `window`.
 */
function restorePrefs(): void {
  if (prefsRestored) return;
  prefsRestored = true;
  let saved: { volume?: unknown; repeat?: unknown } = {};
  try {
    const raw = window.localStorage.getItem(PREF_KEY);
    if (raw !== null) saved = JSON.parse(raw) as { volume?: unknown; repeat?: unknown };
  } catch {
    return; // sin almacenamiento: se queda con los valores por defecto
  }
  const patch: Partial<PlayerState> = {};
  if (typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1) {
    patch.volume = saved.volume;
  }
  if (saved.repeat === "all" || saved.repeat === "one" || saved.repeat === "off") {
    patch.repeat = saved.repeat;
  }
  if (Object.keys(patch).length > 0) set(patch);
}

function persistPrefs(): void {
  try {
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ volume: state.volume, repeat: state.repeat }),
    );
  } catch {
    /* sin almacenamiento: las preferencias solo viven en memoria */
  }
}

function wireEvents(node: HTMLAudioElement): void {
  node.addEventListener("timeupdate", () => {
    set({ currentTime: node.currentTime || 0 });
  });
  node.addEventListener("durationchange", () => {
    const seconds = Number.isFinite(node.duration) ? node.duration : 0;
    set({ duration: seconds });
    // El navegador ya sabe la duracion real: se la devuelve a la pista, que la
    // guardaba como `null` hasta que se abria.
    const current = state.current;
    if (current !== null && current.duration !== seconds) {
      patchTrack(current.id, { duration: seconds });
    }
  });
  node.addEventListener("play", () => set({ isPlaying: true }));
  node.addEventListener("pause", () => set({ isPlaying: false }));
  node.addEventListener("waiting", () => set({ isLoading: true }));
  node.addEventListener("playing", () => set({ isLoading: false }));
  node.addEventListener("canplay", () => set({ isLoading: false }));
  node.addEventListener("ended", () => {
    // `ended` no pasa por play/pause: hay que bajarlo a mano o el boton se queda en
    // "pausado" con la ultima pista ya terminada.
    set({ isPlaying: false });
    onEnded();
  });
  node.addEventListener("error", () => {
    // `detach()` vacia el `src` a proposito y tambien pasa por aqui: sin pista en
    // curso no hay nada que avisar y el error seria ruido en la UI.
    if (state.current === null) return;
    set({ isPlaying: false, isLoading: false, error: describeMediaError(node) });
  });
}

function describeMediaError(node: HTMLAudioElement): string {
  const code = node.error?.code;
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    return "el navegador no sabe reproducir este formato. WebView2 cubre mp3, wav, ogg, flac y m4a.";
  }
  if (code === MediaError.MEDIA_ERR_DECODE) {
    return "el fichero esta danado o no es audio.";
  }
  if (code === MediaError.MEDIA_ERR_NETWORK) {
    return "no se pudo descargar del origen. Revisa la URL y la conexion.";
  }
  if (code === MediaError.MEDIA_ERR_ABORTED) {
    return "se cancelo la carga de la pista.";
  }
  return "no se pudo reproducir la pista.";
}

// ---------------------------------------------------------------------------
// Comandos de reproduccion
// ---------------------------------------------------------------------------

export async function load(track: Track, autoplay = true): Promise<void> {
  const node = audio();
  set({ current: track, currentTime: 0, duration: track.duration ?? 0, isLoading: true, error: null });
  node.src = track.src.url;
  // Cuando venia sonando otra cosa, la carga nueva la para; sin esto el navegador
  // sigue con la anterior hasta que la nueva este lista y el usuario oye un salto.
  node.pause();
  applyVolume(node);
  if (!autoplay) return;
  try {
    await node.play();
  } catch (err) {
    // El navegador rechaza `play()` si no hubo interaccion del usuario. No es un
    // fallo de la app: se informa y se deja la pista cargada para que el usuario
    // pulse reproducir, que ya cuenta como interaccion.
    set({ isPlaying: false, isLoading: false, error: autoplayBlocked(err) });
  }
}

function autoplayBlocked(err: unknown): string | null {
  if (err instanceof DOMException && err.name === "NotAllowedError") {
    return "el navegador ha bloqueado la reproduccion automatica. Pulsa reproducir.";
  }
  return "no se pudo iniciar la reproduccion.";
}

export function toggle(): void {
  const node = element;
  if (node === null || state.current === null) return;
  if (node.paused) {
    if (node.error !== null) {
      // Un `play()` sobre un elemento en error no hace nada: hay que recargar.
      void load(state.current, true);
      return;
    }
    void node.play().catch((err: unknown) => set({ error: autoplayBlocked(err) }));
  } else {
    node.pause();
  }
}

export function pause(): void {
  element?.pause();
}

export function seek(seconds: number): void {
  const node = element;
  if (node === null) return;
  const limit = Number.isFinite(node.duration) && node.duration > 0 ? node.duration : Infinity;
  const target = Math.min(Math.max(seconds, 0), limit);
  // Asignar `currentTime` antes de que haya metadatos lanza o se ignora en Chromium.
  if (node.readyState === 0) {
    node.addEventListener("loadedmetadata", () => {
      node.currentTime = target;
      set({ currentTime: target });
    }, { once: true });
    return;
  }
  node.currentTime = target;
  set({ currentTime: target });
}

export function setVolume(volume: number): void {
  set({ volume: Math.min(Math.max(volume, 0), 1) });
  persistPrefs();
  applyVolume(audio());
}

export function toggleMute(): void {
  userMuted = !userMuted;
  set({ isMuted: userMuted });
  applyVolume(audio());
}

export function setRepeat(mode: RepeatMode): void {
  set({ repeat: mode });
  persistPrefs();
}

/** Quita el aviso de error. No toca la musica, que puede estar sonando sin problema. */
export function clearError(): void {
  set({ error: null });
}

/**
 * Publica un error que no viene del elemento de audio.
 *
 * El `error` del elemento solo cubre fallos de red, decodificacion y formato. Lo de
 * leer las etiquetas de un fichero que no se puede abrir es del motor, y sin esta
 * puerta tendria que llegar a la UI por otro camino.
 */
export function reportError(message: string): void {
  set({ error: message });
}

/** Silencio por software para poder seguir oyendo y speaking sin parar. */
export function setMuted(muted: boolean): void {
  if (userMuted === muted) return;
  userMuted = muted;
  set({ isMuted: muted });
  applyVolume(audio());
}

/**
 * Baja la musica mientras hay transcripcion.
 *
 * # Por que no se guarda el volumen de antes
 *
 * La primera version guardaba `state.volume` antes de bajarlo a 0 y lo restauraba al
 * terminar. El fallo es que el volumen tambien lo mueve el usuario: si subia el
 * slider a mitad de transcripcion, `volumeBeforeDuck` ya no valia, y al parar la
 * musica volvia a un volumen que nadie habia elegido. Ahora `volume` es siempre el
 * del usuario y la bajada vive solo en `ducked`, que `applyVolume` traduce a la
 * ganancia real del elemento. Los dos chemins son independientes y no se pisan.
 *
 * Con el mute manual tampoco hay conflicto: `applyVolume` decide, y si el usuario ya
 * habia silenciado no hay nada que bajar.
 */
export function setDucked(shouldDuck: boolean): void {
  if (shouldDuck === ducked) return;
  ducked = shouldDuck;
  set({ isDucked: shouldDuck });
  // Sin `audio()`: duckear no es un comando del usuario, es una reaccion del pipeline
  // de STT, y no tiene por que crear un `<audio>` en una sesion en la que el usuario
  // nunca toco el reproductor. Si no hay elemento, tampoco hay sonido que bajar.
  if (element !== null) applyVolume(element);
}

function applyVolume(node: HTMLAudioElement): void {
  node.volume = ducked ? 0 : state.volume;
  node.muted = state.isMuted;
}

// ---------------------------------------------------------------------------
// Cola
// ---------------------------------------------------------------------------

/**
 * Anade pistas al final de la cola.
 *
 * Las pistas que ya estaban siguen sonando: agregar no reinicia nada. Cada una lleva
 * un `id` unico porque dos ficheros con el mismo nombre son la misma cancion para el
 * usuario pero no para `src`.
 */
export function enqueue(tracks: readonly Track[]): void {
  if (tracks.length === 0) return;
  const at = state.queue.length;
  const queue = [...state.queue, ...tracks];
  set({ queue });
  if (state.shuffle && order.length > 0) {
    // Anadir al final no mueve los indices de lo que ya estaba, asi que el orden
    // barajado sigue siendo valido y solo se estiran las pistas nuevas. Invalidarlo
    // aqui barajaria de nuevo las que faltan por sonar cada vez que el usuario suelta
    // una cancion, y la cola pareceria no tener orden.
    for (let i = 0; i < tracks.length; i += 1) order.push(at + i);
  } else {
    reindex();
  }
  // Si estaba parado y no hay nada sonando, se arranca con la primera. Es lo que
  // espera el usuario al soltar cinco canciones: que suenen.
  if (state.current === null) {
    void load(queue[0], true);
  }
}

/**
 * Vacia la cola. Si sonaba algo de ella, el audio se para.
 *
 * Libera las URLs de todo lo que habia, no solo de lo visible: una cola de cuarenta
 * pistas que el usuario vacia en un clic dejaba cuarenta blobs de audio y sus portadas
 * retenidos hasta recargar el webview.
 */
export function clearQueue(): void {
  // El elemento se suelta **antes** de revocar: al revocar el origen que tiene puesto,
  // el elemento queda apuntando a una URL muerta y su `error` salta en la consola.
  detach();
  for (const track of state.queue) release(track);
  const current = state.current;
  if (current !== null && !state.queue.some((track) => track.id === current.id)) {
    // `current` puede venir de fuera de la cola si se cargo a mano: tambien se suelta.
    release(current);
  }
  set({ queue: [], current: null, currentTime: 0, duration: 0, isPlaying: false, isLoading: false, error: null });
  reindex();
}

/** Quita una pista. Si era la que suena, se salta a la siguiente. */
export function removeAt(index: number): void {
  const queue = state.queue.slice();
  const removed = queue.splice(index, 1)[0];
  if (removed === undefined) return;
  const current = state.current;
  if (current !== null && current.id === removed.id) {
    // Se suelta el elemento antes que la URL, por el mismo motivo que en `clearQueue`.
    detach();
  }
  release(removed);
  set({ queue });
  reindex();
  if (current !== null && current.id === removed.id) {
    if (queue.length === 0) {
      set({ current: null, currentTime: 0, duration: 0, isPlaying: false });
    } else {
      void load(queue[Math.min(index, queue.length - 1)], true);
    }
  }
}

/**
 * Mueve una pista de sitio.
 *
 * Acepta cualquier par (desde, hasta) y coloca el elemento en el hueco destino, que
 * es lo que produce un arrastre de una posicion a otra. Un "intercambio" en vez de un
 * "cortado y pegado" daria la sensacion de que al soltar la cancion se teletransporta.
 */
export function move(from: number, to: number): void {
  const queue = state.queue.slice();
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
  const [moved] = queue.splice(from, 1);
  if (moved === undefined) return;
  queue.splice(to, 0, moved);
  set({ queue });
  reindex();
}

export function setShuffle(on: boolean): void {
  set({ shuffle: on });
  // Se invalida y se deja que `buildOrder` lo rehaga. La version anterior metia aqui
  // solo la pista en curso, y con una lista de un elemento `nextIndex` hacia
  // `orderAt = 1 >= order.length` y daba por terminada la cola: activar el aleatorio
  // hacia que "siguiente" parase la musica. `buildOrder` ya pone la pista en curso
  // la primera, que es justo lo que hacia falta.
  reindex();
}

/** Pista siguiente segun el modo de repeticion y el aleatorio. */
export function next(): void {
  if (state.queue.length === 0) return;
  if (state.repeat === "one" && state.current !== null) {
    seek(0);
    void element?.play().catch(() => {});
    return;
  }
  const at = nextIndex(1);
  if (at === null) {
    // Ultima pista en modo "off": se para, que es lo unico que tiene sentido. Dejar
    // el boton en pausa y la barra al final evita el bucle infinito de repetir.
    if (state.repeat === "all") {
      seek(0);
      void element?.play().catch(() => {});
    } else {
      element?.pause();
      set({ currentTime: state.duration });
    }
    return;
  }
  void load(state.queue[at], true);
}

export function previous(): void {
  if (state.queue.length === 0) return;
  // Passada de norte a sur, como cualquier reproductor: al principio de la pista se
  // vuelve al principio de la pista, y si ya se esta en el, a la anterior.
  if (element !== null && element.currentTime > 3) {
    seek(0);
    return;
  }
  const at = nextIndex(-1);
  if (at === null) {
    seek(0);
    return;
  }
  void load(state.queue[at], true);
}

function onEnded(): void {
  next();
}

/** Siguiente indice en el orden de reproduccion, o `null` si no hay mas. */
function nextIndex(step: 1 | -1): number | null {
  if (state.shuffle) {
    if (order.length === 0) buildOrder();
    orderAt += step;
    if (orderAt >= order.length) {
      if (state.repeat === "off") {
        orderAt = order.length;
        return null;
      }
      orderAt = 0;
    }
    if (orderAt < 0) {
      if (state.repeat === "off") return null;
      orderAt = order.length - 1;
    }
    return order[orderAt];
  }
  const currentIndex =
    state.current === null
      ? -1
      : state.queue.findIndex((track) => track.id === state.current?.id);
  const target = currentIndex + step;
  if (target >= 0 && target < state.queue.length) return target;
  if (state.repeat === "off") return null;
  if (state.queue.length === 0) return null;
  return step === 1 ? 0 : state.queue.length - 1;
}

/**
 * Orden de reproduccion barajado.
 *
 * Fisher-Yates con `Math.random`. La pista que suena ahora entra la primera, para que
 * al terminar la que venga sea otra y no la misma en bucle.
 */
function buildOrder(): void {
  const size = state.queue.length;
  const currentIndex =
    state.current === null ? -1 : state.queue.findIndex((t) => t.id === state.current?.id);
  const rest: number[] = [];
  for (let i = 0; i < size; i += 1) if (i !== currentIndex) rest.push(i);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = rest[i];
    rest[i] = rest[j];
    rest[j] = tmp;
  }
  order = currentIndex < 0 ? rest : [currentIndex, ...rest];
  orderAt = 0;
}

/** Invalida el orden barajado para que se rehaga en el siguiente salto. */
function reindex(): void {
  order = [];
  orderAt = 0;
}

/**
 * Parchea una pista sin cambiar el estado global de forma visible.
 *
 * El `set` de abajo re-renderiza a quien este pendiente, y `current` es un objeto
 * nuevo en cada `load`, asi que sin esto la barra de la pista en curso no recibiria el
 * nombre de la portada cuando se lee despues.
 */
function patchTrack(id: string, patch: Partial<Track>): void {
  const queue = state.queue.map((track) => (track.id === id ? { ...track, ...patch } : track));
  const current = state.current !== null && state.current.id === id ? { ...state.current, ...patch } : state.current;
  set({ queue, current });
}

// ---------------------------------------------------------------------------
// Memoria
// ---------------------------------------------------------------------------

/**
 * Suelta los recursos de una pista.
 *
 * Un `objectURL` creado con `URL.createObjectURL` no se libera solo cuando el elemento
 * que lo usa desaparece: hay que llamar a `revokeObjectURL` o el blob queda retenido
 * hasta que se recargue el webview. En una cola en la que el usuario quita pistas, eso
 * es memoria de audio que ya no se puede recuperar.
 */
function release(track: Track): void {
  if (track.artwork !== null) URL.revokeObjectURL(track.artwork);
  if (track.src.kind === "file") URL.revokeObjectURL(track.src.url);
}

/**
 * Deja el elemento sin origen.
 *
 * Quitar el `src` y llamar a `load()` es lo que le dice al pipeline nativo que suelte
 * el decodificador. Parar no basta: el elemento sigue teniendo el ultimo origen
 * cargado y ocupa su memoria, y revocar su `objectURL` con el elemento apuntando ahi
 * produce un error de red espurio.
 */
function detach(): void {
  if (element === null) return;
  element.pause();
  element.removeAttribute("src");
  element.load();
}
