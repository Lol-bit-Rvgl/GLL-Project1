"use client";

/**
 * Nivel de audio para el vumetro.
 *
 * Va en su propio hook, y no como `useState` en la pagina, a proposito: el nivel
 * cambia unas 10 veces por segundo y cada cambio re-renderizaria toda la app, incluido
 * el historial de transcripcion, que es lo que mas caro de pintar hay.
 *
 * El patron es el de la version anterior del proyecto: `invoke` en un intervalo
 * rapido que escribe en un `ref`, y un intervalo mas lento que lo pinta. Se leen
 * 10 veces por segundo y se pinta 6-7, que es indistinguible para el ojo y evita
 * un `setState` por lectura.
 *
 * El intervalo se para solo cuando no hay captura: el comando devuelve 0 y no cuesta,
 * pero lanzar 10 `invoke` por segundo sin motivo en una app de escritorio es tirar
 * CPU y bateria.
 */

import { useEffect, useRef, useState } from "react";

import { invoke } from "./bridge";

/** Con que frecuencia se pregunta al backend. */
const READ_MS = 100;
/** Con que frecuencia se pinta el valor leido. */
const PAINT_MS = 150;
/** Historial corto para dibujar la barra, en vez de un solo valor. */
const HISTORY = 48;

export type AudioLevel = {
  /** Nivel actual en [0, 1]. */
  value: number;
  /** Ultimos niveles, del mas antiguo al mas reciente. Para el histograma. */
  history: number[];
};

const SILENT: AudioLevel = { value: 0, history: [] };

export function useAudioLevel(active: boolean): AudioLevel {
  const [level, setLevel] = useState<AudioLevel>(SILENT);
  const valueRef = useRef(0);
  const historyRef = useRef<number[]>([]);

  useEffect(() => {
    // Apagado no se pone a cero con un `setState`: se devuelve `SILENT` desde el
    // final del hook. Un `setState` sincrono aqui solo provocaria un render
    // adicional cada vez que se para la captura, para pintar lo mismo.
    if (!active) return;

    let alive = true;

    const read = window.setInterval(() => {
      void invoke<number>("get_audio_level")
        .then((value) => {
          if (!alive) return;
          const next = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
          valueRef.current = next;
          historyRef.current = [...historyRef.current, next].slice(-HISTORY);
        })
        .catch(() => {
          // El comando falla si el audio todavia no ha arrancado del todo. Se deja
          // el ultimo valor en vez de poner a cero, que seria un parpadeo falso.
        });
    }, READ_MS);

    const paint = window.setInterval(() => {
      if (!alive) return;
      setLevel({ value: valueRef.current, history: historyRef.current });
    }, PAINT_MS);

    return () => {
      alive = false;
      window.clearInterval(read);
      window.clearInterval(paint);
      // Se vacia en la limpieza y no en un efecto aparte: es el unico sitio donde
      // se sabe que ya no se va a pintar lo que hay en los refs.
      valueRef.current = 0;
      historyRef.current = [];
    };
  }, [active]);

  return active ? level : SILENT;
}
