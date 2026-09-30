"use client";

/**
 * Suscripcion a los eventos de transcripcion, con el estado en un unico sitio.
 *
 * # Por que un solo `useState` y no uno por bloque
 *
 * Whisper puede emitir finales a ritmo de frase y parciales cada 500 ms. Con un
 * `useState` por bloque habria decenas de re-renderizados por segundo y el
 * `TranscriptStream` entero se reconciliaria en cada uno. Aqui hay UN estado que
 * cambia por funcion pura (`reduce`), y el componente decide que parte re-pinta.
 *
 * # Autoscroll que se apaga solo
 *
 * Cuando el usuario sube con la rueda esta leyendo lo anterior, y hacerle scroll
 * abajo cada palabra es una falta de respeto. `stickToBottom` se pone a `false` en
 * cuanto deja de estar al fondo, y el boton "Bajar al final" lo vuelve a activar.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import { emptyTranscript, fullText, reduce, sessionEndMs } from "./transcript";
import type { Block, Interim, TranscriptState } from "./transcript";
import { EVENTS } from "@/lib/types";
import type { EngineStatus, TranscriptionSegment } from "@/lib/types";

const STORAGE_KEY = "lyricstream:transcript:v1";

/** Lo que se guarda en `localStorage`. Versionado, para poder migrar o tirar. */
type Persisted = {
  version: 1;
  blocks: Block[];
  interim: Interim;
  speaking: boolean;
  startedAtMs: number;
};

export type UseTranscript = {
  blocks: Block[];
  /** Texto del segmento en curso. */
  interim: string;
  speaking: boolean;
  /** `true` si el scroll automatico esta pegado al final. */
  stickToBottom: boolean;
  /** Texto completo, incluidos los bloques y el parcial abierto. */
  text: string;
  /** Fin de la sesion en ms de flujo. */
  endMs: number;
  /** Fija si el autoscroll sigue pegado al final. */
  setStick: (stick: boolean) => void;
  /** Borra la transcripcion y la persistencia. */
  clear: () => void;
  /** Ultimo estado del motor recibido por el evento `stt-engine-status`. */
  engine: EngineStatus | null;
};

export function useTranscript(): UseTranscript {
  const [state, setState] = useState<TranscriptState>(emptyTranscript);
  const [stickToBottom, setStickToBottom] = useState(true);
  // El estado del motor no se guarda en `TranscriptState` porque no participa en la
  // reduccion: llega por otro evento y solo se usa para pintar la barra.
  const [engine, setEngine] = useState<EngineStatus | null>(null);

  // La referencia viva del estado, para el interval de persistencia. Un `ref` evita
  // depender del estado: si no, el intervalo se recrearia en cada segmento.
  // Se actualiza en un efecto, no durante el render, que React marca como error
  // porque un render puede quedar a medias y dejar el ref con un estado que nunca
  // se llego a pintar.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Suscripcion a los dos eventos. Un solo efecto: cada `listen` se limpia al
  // desmontar y no hay forma de quedar con un listener huerfano, que en Tauri
  // significa seguir recibiendo eventos de una ventana ya cerrada.
  useEffect(() => {
    let alive = true;
    const pending: Promise<UnlistenFn>[] = [
      listen<TranscriptionSegment>(EVENTS.transcription, (event) => {
        if (!alive) return;
        setState((prev) => reduce(prev, event.payload));
      }),
      listen<EngineStatus>(EVENTS.engine, (event) => {
        if (!alive) return;
        setEngine(event.payload);
      }),
    ];
    return () => {
      alive = false;
      for (const item of pending) void item.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Recupera la sesion guardada. Va en un IIFE asincrono, y no como `setState`
  // directo en el cuerpo del efecto, por dos razones: leer `localStorage` en un
  // efecto que corre en el servidor no es valido, y un `setState` sincrono en un
  // efecto fuerza un segundo render de toda la pagina nada mas montar.
  useEffect(() => {
    let alive = true;
    void (async () => {
      // Un turno de macrotarea antes de leer. No es por rendimiento (leer de
      // `localStorage` es rapido), sino para que la restauracion sea un estado
      // normal del ciclo de vida y no una excepcion a "no renderizar desde un
      // efecto". A cambio, un bloque de texto puede aparecer un instante despues.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (!alive) return;
      let restored: TranscriptState | null = null;
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw !== null) {
          const parsed = JSON.parse(raw) as Persisted;
          // La version se comprueba antes de fiarse: un formato viejo con campos
          // distintos daria `undefined` por todas partes, que es peor que empezar
          // de cero con algo que se ve bien.
          if (parsed.version === 1) {
            restored = {
              blocks: parsed.blocks ?? [],
              interim: parsed.interim ?? emptyTranscript().interim,
              speaking: parsed.speaking ?? false,
              startedAtMs: parsed.startedAtMs ?? 0,
            };
          }
        }
      } catch {
        // Un `localStorage` lleno o corrupto no puede romper la app: se descarta y
        // se sigue con la sesion en memoria.
        try {
          window.localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* sin almacenamiento disponible */
        }
      }
      if (restored !== null) setState(restored);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Sondeo del estado del motor.
  //
  // `stt-engine-status` solo se emite al arrancar y al parar, asi que sin esto el
  // piso de ruido y los contadores se quedaban congelados en el valor del arranque
  // durante toda la sesion: el vumetro marcaria un numero que no se movia, que es
  // peor que no marcarlo. Dos segundos es suficiente para un texto auxiliar y deja
  // la UI de verdad (las palabras) depender solo de los eventos de segmento.
  useEffect(() => {
    let alive = true;
    const timer = window.setInterval(() => {
      void invoke<EngineStatus>("get_stt_status")
        .then((next) => {
          if (!alive) return;
          setEngine((prev) => (prev === null || !sameForUi(prev, next) ? next : prev));
        })
        .catch(() => {
          // El comando no esta disponible si la app corre en el navegador sin
          // Tauri. Se ignora: la UI funciona igual, solo sin los contadores.
        });
    }, 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Guarda cada 5 s. Se escribe desde un intervalo y no en cada segmento para no
  // tocar el disco sin parar durante una frase larga.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = stateRef.current;
      // Sin bloques y sin frase abierta no hay nada que preservar.
      if (current.blocks.length === 0 && current.interim.text.trim() === "") return;
      const payload: Persisted = {
        version: 1,
        blocks: current.blocks,
        interim: current.interim,
        speaking: current.speaking,
        startedAtMs: current.startedAtMs,
      };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // Cuota agotada: la sesion sigue viva en memoria, que es lo que importa.
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const setStick = useCallback((stick: boolean) => setStickToBottom(stick), []);

  const clear = useCallback(() => {
    setState(emptyTranscript());
    setStickToBottom(true);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* sin almacenamiento disponible */
    }
  }, []);

  const text = useMemo(() => fullText(state), [state]);
  const endMs = useMemo(() => sessionEndMs(state), [state]);

  return {
    blocks: state.blocks,
    interim: state.interim.text,
    speaking: state.speaking,
    stickToBottom,
    text,
    endMs,
    setStick,
    clear,
    engine,
  };
}

/**
 * Si dos estados del motor se ven igual en pantalla.
 *
 * El sondeo devuelve un objeto nuevo cada vez, y sin esta comparacion el piso de
 * ruido re-renderia la pagina cada 2 s aunque no cambiase de centesima. Solo se miran
 * los campos que la UI pinta: `detail` y `engine` son texto fijo durante toda la
 * sesion, y los contadores `frames`/`segments` cambian, asi que tampoco se comparan.
 */
function sameForUi(a: EngineStatus, b: EngineStatus): boolean {
  return (
    a.running === b.running &&
    a.real_inference === b.real_inference &&
    a.speaking === b.speaking &&
    a.language === b.language &&
    Math.round(a.stats.noise_floor_db) === Math.round(b.stats.noise_floor_db)
  );
}
