/**
 * Enlace entre el motor de reproduccion y React.
 *
 * # `useMusicPlayer` contra `useMusicPlaying`
 *
 * Dos hooks, no uno, porque lo que se pinte cambia el coste. La posicion del audio
 * avanza cuatro veces por segundo, asi que el reproductor tiene que enterarse y
 * `useMusicPlayer` entrega el estado entero. Un componente raiz que solo quiere saber
 * "esta sonando" no deberia repintarse por eso, y por eso existe `useMusicPlaying`,
 * que devuelve un booleano y solo re-renderiza cuando ese booleano cambia.
 *
 * Esa separacion es la que deja que la barra de la transcripcion se entere de que ha
 * empezado a sonar musica sin arrastrar consigo el historial de texto.
 *
 * # `useSyncExternalStore`
 *
 * El estado vive en `audioPlayer.ts` porque pertenece al elemento de audio y no a
 * ningun componente: dos Reproductores en el arbol lo comparten. `useSyncExternalStore`
 * es la herramienta para eso, y `getServerSnapshot` devuelve el estado vacio para que
 * la pagina se pueda prerenderizar sin `document` ni `localStorage`.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import * as engine from "./audioPlayer";
import { readTags, titleFromName } from "./metadata";
import { EMPTY_PLAYER_STATE, isAudioFile } from "./types";
import type { PlayerState, RepeatMode, Track } from "./types";

/** Estado compartido con React. En el servidor es siempre el vacio. */
const SERVER_STATE = EMPTY_PLAYER_STATE;

function subscribe(listener: () => void): () => void {
  return engine.subscribe(listener);
}

/** El estado completo, incluida la posicion. Para el reproductor. */
export function useMusicPlayer(): PlayerState {
  return useSyncExternalStore(subscribe, engine.getState, () => SERVER_STATE);
}

/**
 * Solo si esta sonando.
 *
 * Devuelve un primitivo, y eso es lo que evita el ciclo: si devolviera un objeto
 * nuevo en cada llamada, React lo compararia por identidad y veria un cambio siempre.
 */
export function useMusicPlaying(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => engine.getState().isPlaying,
    () => false,
  );
}

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `t${sequence}`;
}

/**
 * Convierte ficheros en pistas, leyendo etiquetas y creando las URLs.
 *
 * El `objectURL` del audio se crea aqui y no en la cancion: el navegador lo necesita
 * para leer los bytes y `audioPlayer` solo se limita a cambiar el `src`.
 */
export async function tracksFromFiles(files: readonly File[]): Promise<Track[]> {
  const usable = files.filter((file) => isAudioFile(file.name));
  return Promise.all(usable.map((file) => trackFromFile(file)));
}

/** Una pista a partir de un fichero, con sus etiquetas leidas. */
export async function trackFromFile(file: File): Promise<Track> {
  const tags = await readTags(file);
  const url = URL.createObjectURL(file);
  let artwork: string | null = null;
  if (tags.artwork !== null && tags.artwork.length > 0) {
    // Se copia a un buffer propio antes de crear el blob. `tags.artwork` es una vista
    // sobre el buffer de lectura del fichero, que es de 3 MB, y un `Blob` construido
    // sobre una vista arrastra el buffer entero. Aqui la imagen es de unos cientos de
    // kilobytes.
    const copy = new Uint8Array(tags.artwork);
    artwork = URL.createObjectURL(
      new Blob([copy], { type: tags.artworkMime ?? "image/jpeg" }),
    );
  }
  return {
    id: nextId(),
    title: tags.title ?? titleFromName(file.name),
    artist: tags.artist,
    album: tags.album,
    // La duracion la pone el navegador al cargar los metadatos. Aqui no se inventa un
    // valor, porque un numero provisional haria que la barra de progreso mostrara algo
    // que luego se corrige delante del usuario.
    duration: null,
    src: { kind: "file", file, url },
    artwork,
  };
}

/** Una pista a partir de una URL suelta. Sin etiquetas: no hay fichero que leerlas. */
export function trackFromUrl(url: string, title?: string): Track {
  let label = url;
  try {
    label = new URL(url).host || url;
  } catch {
    // Una ruta local como `C:\musica\tema.mp3` no es una URL valida: se usa tal cual.
  }
  return {
    id: nextId(),
    title: title ?? label,
    artist: null,
    album: null,
    duration: null,
    src: { kind: "url", url },
    artwork: null,
  };
}

/** Comandos del reproductor, para que los componentes no importen el motor. */
export type MusicCommands = {
  addFiles: (files: readonly File[]) => Promise<void>;
  addUrl: (url: string) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
  removeAt: (index: number) => void;
  move: (from: number, to: number) => void;
  playAt: (index: number) => void;
  clearQueue: () => void;
  dismissError: () => void;
};

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = {
  off: "all",
  all: "one",
  one: "off",
};

export function useMusicControls(): MusicCommands {
  return useMemo<MusicCommands>(
    () => ({
      addFiles: async (files) => {
        try {
          const tracks = await tracksFromFiles(files);
          engine.enqueue(tracks);
        } catch (err) {
          // Nadie espera esta promesa -el boton la dispara con `void`- y sin esto un
          // rechazo se convertiria en una "unhandled rejection" en consola, que en un
          // webview no ve nadie y encima se come el aviso real.
          engine.reportError(
            `no se pudieron leer los ficheros: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      addUrl: (url) => {
        const clean = url.trim();
        if (clean === "") return;
        engine.enqueue([trackFromUrl(clean)]);
      },
      toggle: engine.toggle,
      next: engine.next,
      previous: engine.previous,
      seek: engine.seek,
      setVolume: engine.setVolume,
      toggleMute: engine.toggleMute,
      cycleRepeat: () => engine.setRepeat(NEXT_REPEAT[engine.getState().repeat]),
      toggleShuffle: () => engine.setShuffle(!engine.getState().shuffle),
      removeAt: engine.removeAt,
      move: engine.move,
      playAt: (index) => {
        const track = engine.getState().queue[index];
        if (track === undefined) return;
        void engine.load(track, true);
      },
      clearQueue: engine.clearQueue,
      dismissError: engine.clearError,
    }),
    [],
  );
}

/**
 * Silencia la musica mientras transcribe, si el usuario lo ha pedido.
 *
 * # Por que un efecto y no un `if` en el boton
 *
 * Porque hay dos formas de empezar a transcribir: el boton de la barra y un atajo que
 * llegue de fuera. Si el silencio dependiera del boton, arrancar por el atajo dejaria
 * la musica sonando durante toda la transcripcion, que es justo lo que el usuario ha
 * pedido evitar. El efecto se dispara con el cambio de `active` y no le importa quien
 * lo haya provocado.
 *
 * El silencio lo guarda el motor, no el hook, para que sobreviva a que el componente
 * que lo pidio se desmonte. Pero el `cleanup` del efecto es el que **deshace** la
 * suspension: si el hook desaparece con la transcripcion en marcha, el motor se
 * quedaria bajando la musica para siempre, y lo unico que lo arregla seria pulsar el
 * boton de parar.
 */
export function useDuckWhileTranscribing(active: boolean, enabled: boolean): void {
  useEffect(() => {
    engine.setDucked(active && enabled);
    return () => {
      engine.setDucked(false);
    };
  }, [active, enabled]);
}

/** Aviso de error del motor, y como quitarlo. */
export function usePlayerError(): { message: string | null; dismiss: () => void } {
  const message = useSyncExternalStore(
    subscribe,
    () => engine.getState().error,
    () => null,
  );
  const dismiss = useCallback(() => engine.clearError(), []);
  return { message, dismiss };
}
