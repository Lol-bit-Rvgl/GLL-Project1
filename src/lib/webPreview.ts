/**
 * Guion de ejemplo para el modo web: emite una transcripcion de mentira, pero por el
 * camino de verdad.
 *
 * # Por que hace falta
 *
 * En el navegador no hay whisper, asi que el canal de texto llega vacio. Con el historial
 * vacio, el buscador no encuentra nada, no hay frase que marcar y los tres exportadores
 * producen un fichero sin nada dentro: se puede mirar la UI pero no probarla. Este guion
 * mete texto de ejemplo para que las cuatro cosas se puedan ejercitar de verdad.
 *
 * # Por que emite eventos y no inserta bloques
 *
 * Insertar bloques directamente en el estado esquivaria todo lo que hay que probar: el
 * reducer, la regla de que el FINAL es una cola y no la frase, la del `start_ms` del
 * primer parcial y el final vacio. Aqui se emiten `TranscriptionSegment` por el bus, con
 * los mismos incrementos que emite `WhisperEngine::increment`, asi que el camino que se
 * ejercita es el de produccion y el que se rompe si se rompe algo es el de verdad.
 *
 * El texto lleva diacriticos a proposito: el buscador normaliza con NFD, asi que escribir
 * `transcripcion` tiene que encontrar `transcripción`, y eso no se ve con un guion en
 * ASCII plano.
 */

import { emitir } from "./bridge";
import { EVENTS } from "./types";
import type { TranscriptionSegment } from "./types";

/** Una frase del guion: sus incrementos y cuando se entrega cada uno. */
type Guion = {
  /** Desfase del inicio de la frase, en ms de flujo. */
  desde: number;
  /** Parciales y el final, en orden. Cada uno es un INCREMENTO. */
  partes: { texto: string; final: boolean }[];
};

/**
 * Cuatro frases.
 *
 * Los parciales Repiten el `desde` con valores crecientes, como los reales: la ventana
 * crece hacia delante y por eso el segundo parcial llega con un `start_ms` mayor. El
 * reducer debe seguir tomando el del PRIMER, o la frase se desplazaria a la derecha.
 */
const GUION: Guion[] = [
  {
    desde: 0,
    partes: [
      { texto: "Buenos días a todos, esto es una transcripción", final: false },
      { texto: " de ejemplo para la vista previa", final: false },
      { texto: " del navegador.", final: true },
    ],
  },
  {
    desde: 3_400,
    partes: [
      { texto: "La captura de audio y el modelo viven en el runtime", final: false },
      { texto: " nativo, así que aquí no hay", final: false },
      { texto: " nada que transcribir de verdad.", final: true },
    ],
  },
  {
    desde: 7_100,
    partes: [
      { texto: "Lo que sí funciona es todo lo demás:", final: false },
      { texto: " el reproductor con su cola", final: false },
      { texto: ", el buscador, los marcadores con Control+B", final: true },
    ],
  },
  {
    desde: 10_800,
    partes: [
      { texto: "y los tres exportadores: TXT, Markdown y SRT.", final: false },
      { texto: " Pruébalos con el botón de la derecha.", final: true },
    ],
  },
];

/** Cada cuanto se entrega un parcial. Un parcial cada 500 ms es lo que hace whisper. */
const CADA_MS = 500;

/** Temporizadores vivos, para poder cancelar el guion a mitad. */
let pendientes: number[] = [];

/**
 * Emite el guion entero, frase a frase, por el bus de eventos.
 *
 * Cada frase se entrega antes de empezar la siguiente: el guion entero de golpe llenaria
 * el historial de golpe, y lo que se quiere ver es el interim acumulandose y cerrandose
 * como en una sesion real.
 *
 * Devuelve las tarjetas para cancelarlo. Cancelar y volver a lanzar no duplica bloques:
 * lo que ya se emitio lo consume el reducer, y lo que se pierde son los timers.
 */
export function emitirEjemplo(): number[] {
  cancelarEjemplo();
  const tarjetas: number[] = [];
  let ms = 0;
  for (const frase of GUION) {
    // El fin de la frase se usa como `duration_ms` del bloque, y el ultimo parcial se
    // retrasa `CADA_MS` para que de tiempo a verlo en pantalla antes de cerrarlo.
    const duracion = frase.partes.length * CADA_MS;
    frase.partes.forEach((parte, indice) => {
      const esFinal = parte.final;
      const segmento: TranscriptionSegment = {
        text: parte.texto,
        is_final: esFinal,
        // Siempre 0 con whisper.cpp; la UI lo trata como "desconocido".
        confidence: 0,
        // El final cubre la frase entera, asi que arranca donde arranca la frase.
        start_ms: esFinal ? frase.desde : frase.desde + indice * CADA_MS,
        duration_ms: duracion,
      };
      tarjetas.push(
        window.setTimeout(() => {
          emitir(EVENTS.transcription, segmento);
        }, ms),
      );
      ms += CADA_MS;
    });
    // Un respiro entre frases, que es lo que hace el segmenter cuando cambia de hablante.
    ms += 600;
  }
  pendientes = tarjetas;
  return tarjetas;
}

/**
 * Cancela el guion en curso.
 *
 * Idempotente, porque la llama la limpieza del efecto de montaje y otra vez el propio
 * guion antes de relanzarse.
 */
export function cancelarEjemplo(): void {
  for (const tarjeta of pendientes) window.clearTimeout(tarjeta);
  pendientes = [];
}