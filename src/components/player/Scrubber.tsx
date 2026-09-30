"use client";

/**
 * Barra de progreso con arrastre.
 *
 * # Por que durante el arrastre manda el estado local
 *
 * `<input type="range">` ya pinta el pulgar mientras se arrastra, pero el valor sale
 * del elemento, no de React, asi que el resto del componente (el tiempo en texto, la
 * duracion) se queda congelado en el valor anterior. Y al re-renderizar el componente
 * para actualizar ese texto, el `value` controlado vuelve a imponer la posicion del
 * engine y el pulgar retrocede, que es el clasico tiron de un scrubber mal hecho.
 *
 * La salida es un solo estado: `drag` con el valor en segundos mientras se arrastra.
 * Cuando hay arrastre se pinta ese; en cuanto se suelta, `onSeek` fija el valor real y
 * `drag` vuelve a `null`.
 *
 * # `pointer` y no `mouse` o `touch`
 *
 * Un solo camino para raton, lapiz y dedo. Ademas `setPointerCapture` evita tener que
 * listening en `window` para seguir al puntero cuando sale del elemento, que es justo
 * cuando el usuario se va del borde derecho a buscar el final.
 */

import { useCallback, useRef, useState } from "react";

import { clock as stamp } from "@/lib/format";

export type ScrubberProps = {
  /** Posicion actual en segundos. */
  value: number;
  /** Duracion total en segundos. */
  max: number;
  /** Fija la posicion. */
  onSeek: (seconds: number) => void;
  disabled?: boolean;
  className?: string;
};

export function Scrubber({ value, max, onSeek, disabled, className }: ScrubberProps) {
  const [drag, setDrag] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);

  const shown = drag ?? value;
  const percent = max > 0 ? Math.min(Math.max(shown / max, 0), 1) * 100 : 0;

  // `max` va en las dependencias en vez de copiarlo a un ref. Un espejo de props en
  // un `ref` escrito durante el render es justo lo que prohibe `react-hooks/refs`, y
  // ademas no hacia falta: la duracion solo cambia cuando el navegador lee los
  // metadatos, una o dos veces por pista, asi que reconstruir los manejadores no
  // cuesta nada.
  const secondsAt = useCallback(
    (clientX: number): number => {
      const node = track.current;
      if (node === null) return 0;
      const box = node.getBoundingClientRect();
      if (box.width === 0) return 0;
      const ratio = Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
      return ratio * max;
    },
    [max],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled || max <= 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag(secondsAt(event.clientX));
    },
    [disabled, max, secondsAt],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Solo mientras hay arrastre. Si se moves el raton por encima sin pulsar, no
      // debeSeekear: seria saltar de golpe a donde pase el cursor.
      if (drag === null) return;
      setDrag(secondsAt(event.clientX));
    },
    [drag, secondsAt],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (drag === null) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      onSeek(drag);
      setDrag(null);
    },
    [drag, onSeek],
  );

  // `onSeek` tambien al terminar con el teclado, que es lo unico que puede mover un
  // `div` sin eventos de puntero. Por eso el `div` es `role="slider"` y no un adorno.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled || max <= 0) return;
      const step = event.shiftKey ? 30 : 5;
      if (event.key === "ArrowRight") onSeek(Math.min(shown + step, max));
      else if (event.key === "ArrowLeft") onSeek(Math.max(shown - step, 0));
      else if (event.key === "Home") onSeek(0);
      else if (event.key === "End") onSeek(max);
      else if (event.key === " " || event.key === "Enter") onSeek(shown);
      else return;
      event.preventDefault();
    },
    [disabled, max, onSeek, shown],
  );

  return (
    <div className={className}>
      <div
        ref={track}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Posicion de la reproduccion"
        aria-valuemin={0}
        aria-valuemax={Math.floor(max)}
        aria-valuenow={Math.floor(shown)}
        aria-valuetext={`${stamp(shown * 1000)} de ${stamp(max * 1000)}`}
        aria-disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className={`group relative flex h-4 w-full items-center ${disabled ? "cursor-default opacity-50" : "cursor-pointer"}`}
      >
        {/*
          El relleno se escala, no se mide. `width` en porcentaje obliga al navegador a
          recalcular la disposicion del relleno y de todo lo que viene detras (el
          cabezal va posicionado con `left`, asi que dependeria de el); `scaleX` lo
          resuelve el compositor con una matriz y el resto del panel ni se entera.
          El `w-full` mantiene el ancho real para que la escala parta de la pista
          entera y no de un ancho de 0.
        */}
        <div className="h-1 w-full overflow-hidden rounded-full bg-obsidian">
          <div
            className="h-full w-full origin-left rounded-full bg-gradient-to-r from-neon to-flare
                       transition-transform duration-75"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        </div>
        {/* El cabezal se amplia con el hover del grupo, no con su propio hover: si no,
            en el momento de pulsar sobre el puntero se salta de tamano. El halo es
            `box-shadow` para que no genere una caja nueva ni empuje al texto de los
            tiempos que tiene al lado. */}
        <span
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full bg-gold opacity-0
                     transition-opacity group-hover:opacity-100"
          style={{ left: `${percent}%`, boxShadow: "0 0 8px #ff6b00, 0 0 16px rgb(255 107 0 / 0.5)" }}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-ink/70 tabular-nums">
        <span>{stamp(shown * 1000)}</span>
        <span>{max > 0 ? stamp(max * 1000) : "--:--"}</span>
      </div>
    </div>
  );
}
