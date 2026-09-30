/**
 * Modelo de la transcripcion en la UI: bloques consolidados + texto en curso.
 *
 * # El problema que resuelve
 *
 * Whisper emite SOLO el incremento desde el parcial anterior. Si la UI concatenase
 * todos los eventos en una lista plana, no podria saber donde acaba una frase y
 * empieza la siguiente, y el SRT saldria con lineas de tres palabras.
 *
 * Aqui hay dos estados, y son deliberadamente distintos:
 *
 * - `blocks`: frases ya cerradas (`is_final: true`). Inmutables. Es lo que se
 *   exporta y lo que sobrevive a una recarga.
 * - `interim`: el texto del segmento en curso, como cadena. Se REEMPLAZA en cada
 *   parcial en vez de acumularse, porque cada parcial llega con el incremento
 *   respecto al anterior y la referencia correcta es el total del bloque abierto.
 *
 * # Por que el parcial se acumula dentro del bloque y no se solapa
 *
 * Los parciales de una frase se acumulan: `1,2` y luego `3` dan "1,2 3". El final
 * cierra el bloque con lo acumulado mas el cierre del propio final. Es exactamente
 * lo que hace `WhisperEngine::increment` en Rust, visto desde el otro lado.
 */

import { joinIncrements } from "./format";
import type { TranscriptionSegment } from "./types";

/** Una frase consolidada. Inmutable una vez creada. */
export type Block = {
  /** Indice estable, para las claves de React. */
  id: number;
  /** Texto completo de la frase. */
  text: string;
  /** Desfase del inicio de la frase respecto al inicio del flujo, en ms. */
  startMs: number;
  /** Duracion de la frase, en ms. */
  durationMs: number;
  /** `true` si el bloque esta marcado como punto clave. */
  bookmarked?: boolean;
};

/** Texto del segmento en curso, separado de los bloques ya cerrados. */
export type Interim = {
  /** Acumulado de los parciales de la frase abierta. */
  text: string;
  /** Desfase del inicio de la frase abierta, en ms. */
  startMs: number;
  /** Duracion de la ultima ventana entregada al motor, en ms. */
  durationMs: number;
};

/** Estado completo del canal de texto. */
export type TranscriptState = {
  blocks: Block[];
  interim: Interim;
  /** `true` si hay una frase en curso (con o sin texto). */
  speaking: boolean;
  /** Instante de inicio de la sesion, en ms del flujo. */
  startedAtMs: number;
};

/**
 * Estado inicial: nada grabado, sin sesion abierta.
 *
 * No lleva un contador de palabras a proposito. La UI cuenta sobre el texto que
 * muestra, bloques y frase abierta juntos, con `wordCount` de `format.ts`: un
 * contador que solo suma bloques cerrados se desincroniza del texto en pantalla en
 * cuanto whisper esta a media frase, y son dos numeros distintos al lado.
 */
export function emptyTranscript(): TranscriptState {
  return {
    blocks: [],
    interim: { text: "", startMs: 0, durationMs: 0 },
    speaking: false,
    startedAtMs: 0,
  };
}

/**
 * Incorpora un segmento del backend.
 *
 * Pura y sin efectos: recibe el estado anterior y devuelve el siguiente. Asi el hook
 * puede decidir cuando renderizar, y los tests pueden ejercitar la transicion sin
 * montar React.
 */
export function reduce(state: TranscriptState, segment: TranscriptionSegment): TranscriptState {
  // Nombres en snake_case: `TranscriptionSegment` no lleva `rename_all`, asi que es
  // literalmente como serde los pone en el JSON del evento.
  const { is_final: isFinal, text, start_ms: startMs, duration_ms: durationMs } = segment;

  if (!isFinal) {
    // Un parcial con el campo `text` vacio se ignora: whisper no tiene nada que
    // anadir todavia, y crear un bloque con texto vacio haria parpadear la UI.
    if (text.trim() === "") {
      return state.speaking ? { ...state, interim: { ...state.interim, durationMs } } : state;
    }
    const interim: Interim = {
      text: joinIncrements([state.interim.text, text]),
      // El inicio del bloque lo fija el PRIMER parcial. Los siguientes llegan con un
      // `start_ms` mayor porque la ventana ha crecido hacia delante; tomarlo cada vez
      // desplazaria la frase hacia la derecha segun avanza.
      startMs: state.speaking ? state.interim.startMs : startMs,
      durationMs,
    };
    return { ...state, interim, speaking: true };
  }

  // Un final VACIO tira lo acumulado. Es la unica decision que este fichero toma
  // sobre el texto, y es deliberada:
  //
  // whisper entrega el final como la cola que el ultimo parcial dejo sin cubrir, asi
  // que un final vacio quiere decir que la ventana completa no produjo ninguna palabra
  // nueva. Si el parcial habia dicho "[INAUDIBLE]" o "you are country" - lo que pasa
  // con un segundo de audio -, el final vacio es la senal de que those eran
  // alucinaciones. Guardarlas seria meter ruido en el historial y en el SRT, que es
  // justo el problema que la app promise resolver.
  //
  // El coste es que un final vacio por averia del motor se come la frase. Se acepta:
  // perder texto es reversible (esta en el parcial mientras se ve), y fabricar una frase
  // en el fichero exportado no lo es.
  if (text.trim() === "") {
    return { ...state, interim: emptyInterim(), speaking: false };
  }

  // El final no cubre por si solo la frase: es la cola pendiente. La cabeza son los
  // parciales que ya se estaban viendo en pantalla, que es la unica copia que queda.
  const pending = joinIncrements([state.interim.text, text]);

  const block: Block = {
    id: nextId(state),
    text: pending,
    // Tambien aqui manda el bloque abierto, no el final: el final cubre la frase
    // entera, asi que su `start_ms` es el mismo. Se conserva el del primer parcial
    // porque es el unico que se ha visto en pantalla.
    startMs: state.speaking ? state.interim.startMs : startMs,
    // La duracion del final es la de la ventana completa, que es la de la frase.
    durationMs: state.speaking ? Math.max(durationMs, state.interim.durationMs) : durationMs,
  };

  return {
    blocks: [...state.blocks, block],
    interim: emptyInterim(),
    speaking: false,
    startedAtMs: state.startedAtMs || startMs,
  };
}

function emptyInterim(): Interim {
  return { text: "", startMs: 0, durationMs: 0 };
}

/**
 * Identificador del siguiente bloque.
 *
 * No se usa `Date.now()` ni un contador global: el estado serializado en
 * `localStorage` y el recien montado tienen que coincidir, y un contador global
 * arrancaria en un valor distinto segun como se haya cargado la pagina.
 */
function nextId(state: TranscriptState): number {
  const last = state.blocks[state.blocks.length - 1];
  return last === undefined ? 0 : last.id + 1;
}

/** Todo el texto de la sesion, para el portapapeles y el TXT. */
export function fullText(state: TranscriptState): string {
  const closed = state.blocks.map((block) => block.text);
  const open = state.interim.text.trim() === "" ? [] : [state.interim.text];
  return joinIncrements([...closed, ...open]);
}

/**
 * Alterna el marcador de un bloque y devuelve el historial nuevo.
 *
 * # Por que vive aqui y no en el componente
 *
 * Es la misma razon que `reduce`: la accion llega por un atajo de teclado, y el atajo
 * esta a un componente de distancia del que pinta la lista. Si la mutacion se hiciera en
 * el boton, el `Ctrl+B` tendria que duplicarla, y en cuanto las dos copias se
 * desincronizasen el atajo y el boton marcarian frases distintas.
 *
 * Un bloque marcado no se toca: se devuelve una copia con `bookmarked` invertido y el
 * resto del historial con las mismas referencias. Cambiar el estado de un bloque sin
 * re-renderizar el resto es justo lo que evita el tirón cuando el historial tiene
 * cientos de frases.
 */
export function toggleBookmark(state: TranscriptState, id: number): TranscriptState {
  let encontrado = false;
  const blocks = state.blocks.map((block) => {
    if (block.id !== id) return block;
    encontrado = true;
    return { ...block, bookmarked: !block.bookmarked };
  });
  // Un id que no existe no cambia el estado: devolver el mismo objeto evita que el
  // historial entero se re-renderice por un atajo que no iba a marcar nada.
  if (!encontrado) return state;
  return { ...state, blocks };
}

/**
 * Los bloques marcados, en orden.
 *
 * Recibe la lista y no el estado entero: es lo que necesita, y asi la UI puede pasarsela
 * sin construir un `TranscriptState` a medias. Es lo que va a la cabecera del Markdown y
 * lo que cuenta la insignia del boton.
 */
export function bookmarkedBlocks(blocks: readonly Block[]): Block[] {
  return blocks.filter((block) => block.bookmarked === true);
}

/**
 * Fin de la sesion, en ms de flujo.
 *
 * Se usa el final del ultimo bloque, no un reloj de pared: el flujo puede empezar
 * con un silencio de varios segundos, y `Date.now()` contaria ese rato como sesion.
 */
export function sessionEndMs(state: TranscriptState): number {
  const last = state.blocks[state.blocks.length - 1];
  if (last === undefined) return 0;
  return last.startMs + last.durationMs;
}
