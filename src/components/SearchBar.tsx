"use client";

/**
 * Campo del buscador interno.
 *
 * # Por que es un componente aparte
 *
 * El foco al abrir exige un `useEffect`, y `TranscriptStream` tiene prohibido tener
 * cualquier efecto: `pruebas/estructural.mjs` lo comprueba, porque el contador de frases
 * sin leer tiene que derivarse del ancla y no contarse en un efecto. Sacar la barra a su
 * propio fichero mantiene las dos cosas: el canal sigue sin efectos, y el buscador tiene
 * el suyo.
 *
 * # Por que no re-renderiza el historial
 *
 * El campo es un `input` controlado por el hook de la pagina. Cuando el usuario escribe,
 * cambia `query`, y `TranscriptStream` vuelve a renderizar para resaltar. Eso es
 * inevitable con resaltado en vivo, y es lo que el usuario ha pedido al abrir el
 * buscador. Lo que si se evita es que el re-render toque las filas que no coinciden: cada
 * fila es un `memo` y solo cambia la que lleva la palabra.
 */

import { useEffect, useRef } from "react";

export type SearchBarProps = {
  /** Texto actual. */
  query: string;
  /** Fija el texto. Se llama en cada pulsacion, para el resaltado en vivo. */
  setQuery: (value: string) => void;
  /** Coincidencias en todo el historial. */
  matchCount: number;
  /** Cierra el buscador. */
  onClose: () => void;
  /** `true` mientras el buscador esta abierto, para no robar el foco dos veces. */
  open: boolean;
};

export function SearchBar({ query, setQuery, matchCount, onClose, open }: SearchBarProps) {
  const input = useRef<HTMLInputElement>(null);

  // El foco va aqui, y no en el `onClick` del boton, porque el buscador tambien se abre
  // con `Ctrl+F`. Si lo pusiera el boton, el atajo no llevaria el cursor al campo, y
  // escribir despues de `Ctrl+F` no haria nada.
  //
  // Con `open` en las dependencias: al reabrir el buscador vuelve a tomar el foco. El
  // `input` esta montado solo cuando `open` es true (lo decide el padre), asi que el
  // efecto corre justo en la transicion de cerrado a abierto.
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
  }, [open]);

  const vacio = query.trim() === "";
  const etiqueta = vacio
    ? "sin texto"
    : matchCount === 0
      ? "sin coincidencias"
      : `${matchCount} ${matchCount === 1 ? "coincidencia" : "coincidencias"}`;

  return (
    <div className="flex items-center gap-3 border-b border-neon/12 bg-panel/40 px-6 py-2">
      <svg
        viewBox="0 0 16 16"
        className="h-4 w-4 shrink-0 fill-none stroke-slate-ink stroke-[1.5]"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" strokeLinecap="round" />
      </svg>

      <input
        ref={input}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Escape dentro del campo cierra el buscador. Lo mismo hace el atajo global,
          // pero aqui esta para que funcione sin que el listener de `window` tenga que
          // mirar donde esta el foco.
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        type="text"
        placeholder="Buscar en la transcripcion"
        aria-label="Buscar en la transcripcion"
        className="min-w-0 flex-1 bg-transparent text-sm text-snow outline-none
                   placeholder:text-slate-ink/60"
      />

      <span
        // `aria-live` para que el recuento se anuncie al cambiar sin mover el foco: el
        // usuario esta escribiendo y no puede mirar el numero mientras teclea.
        aria-live="polite"
        className="shrink-0 font-mono text-xs text-slate-ink tabular-nums"
      >
        {etiqueta}
      </span>

      <button
        type="button"
        onClick={onClose}
        title="Cerrar el buscador (Esc)"
        aria-label="Cerrar el buscador"
        className="shrink-0 rounded border border-neon/20 px-2 py-0.5 text-[11px] text-slate-ink
                   transition-colors hover:border-neon/60 hover:text-snow
                   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
      >
        Cerrar
      </button>
    </div>
  );
}
