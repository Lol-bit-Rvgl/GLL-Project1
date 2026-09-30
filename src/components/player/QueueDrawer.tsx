"use client";

/**
 * Cajon de la cola de reproduccion.
 *
 * # Reordenar sin libreria
 *
 * `HTML5` no tiene una API de arrastrar filas; la que se usa en la web es HTML5 drag
 * and drop, y aqui no sirve: WebView2 la implementa, pero el arrastre de ficheros
 * (el "soltar musica en la ventana") tambien es drag and drop, y el navegador no
 * distingue uno de otro. Con las dos montadas, soltar un `.mp3` encima de una fila
 * intentaria mover la fila en vez de anadir la cancion, que es un fallo confuso.
 *
 * Asi que el reordenado va con eventos de puntero: un boton de "asidero" que se pulsa
 * y se arrastra. Ademas es mejor en escritorio, donde arrastrar con el raton una fila
 * para moverla dos lineas es un gasto, y hay botones de subir y bajar al lado por si
 * tampoco.
 *
 * # Un solo elemento arrastrado
 *
 * `drag` guarda el indice de origen y `over` el de destino. Solo se pinta el hueco
 * cuando hay un arrastre en curso, para que la lista en reposo no tenga lineas con
 * hueco permanente entre ellas.
 */

import { useCallback, useEffect, useState } from "react";

import { clock } from "@/lib/format";
import type { Track } from "@/lib/player/types";

export type QueueDrawerProps = {
  open: boolean;
  tracks: readonly Track[];
  currentId: string | null;
  onClose: () => void;
  onRemoveAt: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onClear: () => void;
  onPick: (index: number) => void;
  onAddUrl: (url: string) => void;
};

export function QueueDrawer({
  open,
  tracks,
  currentId,
  onClose,
  onRemoveAt,
  onMove,
  onClear,
  onPick,
  onAddUrl,
}: QueueDrawerProps) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [url, setUrl] = useState("");

  // Escape cierra. Sin esto, un cajon modal sin salida por teclado deja al usuario
  // atrapado en el, porque el foco sigue en el boton que lo abrio.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  const commit = useCallback(() => {
    if (drag !== null && over !== null && drag !== over) onMove(drag, over);
    setDrag(null);
    setOver(null);
  }, [drag, onMove, over]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Lista de reproduccion"
        onClick={(event) => event.stopPropagation()}
        className="flex h-full w-[26rem] max-w-full flex-col border-l border-neon/20
                   bg-panel/95 shadow-2xl backdrop-blur"
      >
        <header className="flex items-center justify-between border-b border-neon/12 px-4 py-3">
          <h2 className="text-sm font-medium text-snow">
            Cola
            <span className="ml-2 font-mono text-xs text-slate-ink">{tracks.length}</span>
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onClear}
              disabled={tracks.length === 0}
              className="rounded px-2 py-1 text-xs text-slate-ink transition-colors
                         hover:text-red-300 disabled:opacity-40 disabled:hover:text-slate-ink"
            >
              Vaciar
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar la lista"
              className="rounded p-1 text-slate-ink transition-colors hover:text-snow"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tracks.length === 0 ? (
            <p className="p-6 text-center text-xs text-slate-ink">
              La cola esta vacia. Suelta ficheros en la ventana o pega una URL abajo.
            </p>
          ) : (
            <ul className="divide-y divide-neon/8">
              {tracks.map((track, index) => {
                const isCurrent = track.id === currentId;
                return (
                  <li
                    key={track.id}
                    onPointerEnter={() => drag !== null && setOver(index)}
                    onPointerUp={commit}
                    className={`group flex items-center gap-2 px-3 py-2 transition-colors ${
                      over === index && drag !== null && drag !== index
                        ? "bg-neon/10"
                        : "hover:bg-raised"
                    } ${isCurrent ? "border-l-2 border-neon bg-raised/60 pl-2" : "border-l-2 border-transparent"}`}
                  >
                    <button
                      type="button"
                      onPointerDown={(event) => {
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDrag(index);
                        setOver(index);
                      }}
                      aria-label={`Reordenar ${track.title}`}
                      className="cursor-grab touch-none text-slate-ink opacity-0 transition-opacity
                                 hover:text-snow group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <svg viewBox="0 0 12 16" className="h-4 w-3 fill-current" aria-hidden="true">
                        <circle cx="4" cy="4" r="1.3" />
                        <circle cx="8" cy="4" r="1.3" />
                        <circle cx="4" cy="8" r="1.3" />
                        <circle cx="8" cy="8" r="1.3" />
                        <circle cx="4" cy="12" r="1.3" />
                        <circle cx="8" cy="12" r="1.3" />
                      </svg>
                    </button>

                    <button
                      type="button"
                      onClick={() => onPick(index)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      {track.artwork ? (
                        <img
                          src={track.artwork}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-raised">
                          <NoteIcon />
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        {/*
                          La pista en curso se marca con un punto que late, no solo con
                          el color del texto. El color se pierde en una lista larga con
                          el resto en gris, y el punto es lo que el ojo va a buscar
                          cuando la cola tiene 40 entradas.
                        */}
                        <span
                          className={`flex items-center gap-1.5 truncate text-xs ${
                            isCurrent ? "text-gold" : "text-snow"
                          }`}
                        >
                          {isCurrent && <span className="live-dot shrink-0" aria-hidden="true" />}
                          {track.title}
                        </span>
                        {track.artist !== null && (
                          <span className="block truncate text-[10px] text-slate-ink">
                            {track.artist}
                          </span>
                        )}
                      </span>
                    </button>

                    <span className="shrink-0 font-mono text-[10px] text-slate-ink/70 tabular-nums">
                      {track.duration !== null ? clock(track.duration * 1000) : "--:--"}
                    </span>

                    <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <IconButton
                        label="Subir"
                        disabled={index === 0}
                        onClick={() => onMove(index, index - 1)}
                        path="M4 10l4-4 4 4"
                      />
                      <IconButton
                        label="Bajar"
                        disabled={index === tracks.length - 1}
                        onClick={() => onMove(index, index + 1)}
                        path="M4 6l4 4 4-4"
                      />
                      <IconButton
                        label="Quitar de la cola"
                        onClick={() => onRemoveAt(index)}
                        path="M5 5l6 6M11 5l-6 6"
                        stroke
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            onAddUrl(url);
            setUrl("");
          }}
          className="flex gap-2 border-t border-neon/12 p-3"
        >
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="URL de audio o ruta local"
            aria-label="Anadir por URL"
            className="min-w-0 flex-1 rounded-md border border-neon/15 bg-raised px-2.5 py-1.5
                       text-xs text-snow placeholder:text-slate-ink/60
                       focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
          />
          <button
            type="submit"
            disabled={url.trim() === ""}
            className="rounded-md border border-neon/30 px-3 py-1.5 text-xs text-snow
                       transition-colors hover:bg-neon/10 hover:border-neon/60
                       disabled:cursor-not-allowed disabled:opacity-40"
          >
            Anadir
          </button>
        </form>
      </aside>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  path,
  stroke,
  disabled,
}: {
  label: string;
  onClick: () => void;
  path: string;
  stroke?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded p-1 text-slate-ink transition-colors hover:text-snow
                 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-slate-ink"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
        <path
          d={path}
          stroke={stroke === true ? "currentColor" : "none"}
          strokeWidth={stroke === true ? 1.5 : undefined}
          strokeLinecap="round"
          fill={stroke === true ? "none" : "currentColor"}
        />
      </svg>
    </button>
  );
}

function NoteIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-slate-ink" aria-hidden="true">
      <path d="M13 2.5v8.2a2.3 2.3 0 1 1-1.5-2.15V5.2L6 6.1v6.4a2.3 2.3 0 1 1-1.5-2.15V4.4z" />
    </svg>
  );
}
