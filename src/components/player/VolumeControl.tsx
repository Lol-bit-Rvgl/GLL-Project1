"use client";

/**
 * Control de volumen.
 *
 * # Slider propio y no `input[type=range]`
 *
 * Por lo mismo que el scrubber: durante el arrastre manda un estado local, y al
 * soltar se entrega al motor. Con un `range` controlado, cada cambio re-renderiza
 * desde el estado global y el pulgar se pelea con el valor.
 *
 * Aqui se aprovecha ademas que el silencio por el boton y la bajada automatica durante
 * la transcripcion no son lo mismo: `isMuted` es lo que el usuario pidio, y la bajada
 * temporal solo mueve el control. Si se confunden, al terminar de transcribir el
 * usuario se quedaria con la musica silenciada sin haberlo pedido.
 */

import { useCallback, useRef, useState } from "react";

export type VolumeControlProps = {
  /** Ganancia en `[0, 1]`. */
  volume: number;
  /** `true` si el usuario silencio a proposito. */
  isMuted: boolean;
  onVolume: (volume: number) => void;
  onToggleMute: () => void;
  /** `true` si ahora mismo la musica esta bajada por la transcripcion. */
  ducked?: boolean;
};

export function VolumeControl({
  volume,
  isMuted,
  onVolume,
  onToggleMute,
  ducked,
}: VolumeControlProps) {
  const [drag, setDrag] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);

  const shown = drag ?? volume;
  const percent = Math.min(Math.max(shown, 0), 1) * 100;

  const volumeAt = useCallback((clientX: number): number => {
    const node = track.current;
    if (node === null) return 0;
    const box = node.getBoundingClientRect();
    if (box.width === 0) return 0;
    return Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag(volumeAt(event.clientX));
    },
    [volumeAt],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (drag === null) return;
      setDrag(volumeAt(event.clientX));
    },
    [drag, volumeAt],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (drag === null) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      onVolume(drag);
      setDrag(null);
    },
    [drag, onVolume],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 0.25 : 0.05;
      let next: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") next = shown + step;
      else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = shown - step;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = 1;
      else return;
      event.preventDefault();
      onVolume(Math.min(Math.max(next, 0), 1));
    },
    [onVolume, shown],
  );

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onToggleMute}
        aria-pressed={isMuted}
        aria-label={isMuted ? "Activar el sonido" : "Silenciar"}
        title={ducked ? "Volumen bajo automaticamente por la transcripcion" : undefined}
        className={`rounded p-1 transition-colors
                   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon ${
                     ducked
                       ? "text-gold"
                       : isMuted
                         ? "text-slate-ink/60 hover:text-snow"
                         : "text-snow hover:text-gold"
                   }`}
      >
        <SpeakerIcon muted={isMuted || shown === 0} />
      </button>

      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Volumen"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className="group relative flex h-4 w-24 cursor-pointer items-center"
      >
        {/*
          Igual que el scrubber: el relleno se escala, no se mide, para no relayout.
          Aqui importa mas que ahi, porque este control se redibuja con cada
          `timeupdate` mientras la transicion de ducking esta en curso, que es
          justo cuando mas se notaria un salto de un pixel.
        */}
        <div className="h-1 w-full overflow-hidden rounded-full bg-obsidian">
          <div
            className={`h-full w-full origin-left rounded-full transition-transform duration-75 ${
              ducked ? "bg-olive" : "bg-gradient-to-r from-neon to-flare"
            }`}
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        </div>
        <span
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full bg-gold opacity-0
                     transition-opacity group-hover:opacity-100"
          style={{
            left: `${percent}%`,
            boxShadow: ducked ? "0 0 8px #ff9d00" : "0 0 8px #ff6b00",
          }}
        />
      </div>
    </div>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M4 7.5h3L11 4v12L7 12.5H4z" />
      {muted ? (
        <path d="M13.5 7 17 10.5 13.5 14z" />
      ) : (
        <>
          <path d="M13 6.8a4.5 4.5 0 0 1 0 6.4l-.9-.9a3.4 3.4 0 0 0 0-4.6z" />
          <path d="M15 4.8a7.2 7.2 0 0 1 0 10.4l-.9-.9a6.1 6.1 0 0 0 0-8.6z" opacity="0.7" />
        </>
      )}
    </svg>
  );
}
