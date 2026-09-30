/**
 * Tipos del reproductor de musica.
 *
 * # Por que NO se usa Web Audio API
 *
 * Un `AudioContext` con `ScriptProcessorNode` obliga al audio a pasar por el hilo
 * principal de JavaScript, que es justo el hilo que renderiza la transcripcion y
 * procesa los eventos de whisper. Con streams largos, eso se traduce en caidas de
 * fotogramas en la UI. Un `HTMLAudioElement` deja el decodificador en el hilo de
 * multimedia del webview, fuera del camino critico: la musica no puede bloquear al
 * pipeline de STT porque no pasa por el. Ver `audioPlayer.ts`.
 *
 * # Por que la portada es un `string` y no bytes
 *
 * Viene de un `Blob`, y lo que se guarda es la `objectURL` de ese blob. Los bytes en
 * memoria serian una copia mas de algo que el navegador ya tiene, y el coste de
 * mantenerlos seria proporcional al tamano de la cubierta, no al de la cancion.
 */

import type { AudioSource } from "@/lib/types";

/** Una pista de la cola. */
export type Track = {
  /** Identificador estable, para las claves de React. */
  id: string;
  /** Titulo, del metadato del fichero o del nombre del fichero. */
  title: string;
  /** Artista, si las etiquetas lo traian. */
  artist: string | null;
  /** Album, si las etiquetas lo traian. */
  album: string | null;
  /** Duracion en segundos, si el navegador la pudo leer. */
  duration: number | null;
  /** Origen de los bytes. */
  src: TrackSource;
  /** `objectURL` de la portada, si el fichero traia imagen. */
  artwork: string | null;
};

/** De donde salen los bytes de una pista. */
export type TrackSource =
  | { kind: "file"; file: File; url: string }
  | { kind: "url"; url: string };

/** Como se repite la cola al llegar al final. */
export type RepeatMode = "off" | "all" | "one";

/** Instantanea completa del reproductor. */
export type PlayerState = {
  /** `null` si la cola esta vacia. */
  current: Track | null;
  isPlaying: boolean;
  /** `true` mientras se esta moviendo de una pista a otra. */
  isLoading: boolean;
  /** Posicion actual en segundos. */
  currentTime: number;
  /** Duracion de la pista actual en segundos; 0 si no se sabe aun. */
  duration: number;
  /** Ganancia en `[0, 1]`, antes de mute. Es la del usuario, no la efectiva. */
  volume: number;
  isMuted: boolean;
  /**
   * `true` si el motor esta bajando la musica por la transcripcion.
   *
   * Va aparte de `volume` a proposito: bajarla no es cambiarle el volumen al usuario.
   * Si se guardara en `volume`, al mover el slider durante una transcripcion se
   * pisarian las dos cosas y al terminar la musica volveria a un volumen que el
   * usuario nunca eligio.
   */
  isDucked: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  /** La cola, en orden de reproduccion. */
  queue: Track[];
  /** Ultimo error, para mostrarlo y no perderlo en un `console`. */
  error: string | null;
};

/** Estado inicial. Sin `HTMLAudioElement`: el modulo se puede importar en SSR. */
export const EMPTY_PLAYER_STATE: PlayerState = {
  current: null,
  isPlaying: false,
  isLoading: false,
  currentTime: 0,
  duration: 0,
  volume: 0.6,
  isMuted: false,
  isDucked: false,
  repeat: "off",
  shuffle: false,
  queue: [],
  error: null,
};

/** Extension que acepta el navegador. `.flac` y `.m4a` los soporta WebView2. */
export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus"] as const;

/** `true` si el nombre parece un fichero de audio que podemos intentar. */
export function isAudioFile(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Lo que hay que saber para avisar sobre la interaccion con la captura.
 *
 * Se agrupa aqui para que la barra de control y el reproductor no tengan que
 * duplicar el criterio, y para que el motivo quede escrito una sola vez.
 */
export type CaptureConflict = {
  /** `true` si la musica se va a transcribir a si misma. */
  warns: boolean;
  /** Texto del aviso. */
  message: string | null;
};

/**
 * Si la musica que suena va a acabar en la transcripcion.
 *
 * # Por que con loopback SI entra, y con auriculares NO se arregla
 *
 * El loopback de WASAPI no es una escucha acustica: abre el endpoint de render por
 * defecto con `AUDCLNT_STREAMFLAGS_LOOPBACK`, que es un grifo digital sobre la mezcla
 * que el sistema esta emitiendo. El `<audio>` del webview sale por ese mismo endpoint.
 * Por lo tanto, con loopback la musica entra al cien por cien, y **ponerse auriculares
 * no cambia nada**, porque el problema no es que el altavoz suene, es que la senal esta
 * en la mezcla digital antes de llegar al altavoz. La unica forma de evitarlo es bajar
 * el volumen, silenciar, o mover la salida del reproductor a otro dispositivo.
 *
 * Con microfono, en cambio, la musica no se transcribe salvo que suene lo bastante
 * alta para que la sala la recoja. Ahi el aviso no procede: seria ruido.
 *
 * # Por que exige `capturing`
 *
 * Sin ese tercer parametro, tener el origen puesto en "sistema" y musica sonando
 * bastaria para avisar, y el aviso aparecia antes de que el usuario hubiera pulsado
 * grabar. Un aviso que aparece sin que todavia pase nada es el tipo de aviso que la
 * gente aprende a ignorar.
 */
export function captureConflict(
  source: AudioSource,
  capturing: boolean,
  isPlaying: boolean,
): CaptureConflict {
  if (source !== "loopback" || !capturing || !isPlaying) {
    return { warns: false, message: null };
  }
  return {
    warns: true,
    message:
      "La musica esta saliendo por el dispositivo que el loopback esta capturando, " +
      "asi que se va a transcribir a si misma. Los auriculares no ayudan: el loopback " +
      "toma la mezcla digital antes del altavoz. Baja el volumen, silencia, o mueve la " +
      "salida del reproductor a otro dispositivo.",
  };
}
