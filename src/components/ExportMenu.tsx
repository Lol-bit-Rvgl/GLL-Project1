"use client";

/**
 * Menu de exportacion: TXT, Markdown y SRT.
 *
 * El menu se cierra con Escape y al pinchar fuera, porque un desplegable que se
 * queda abierto tapa el texto justo cuando el usuario quiere leer lo que exporto.
 *
 * Los botones se desactivan cuando no hay nada consolidado. Un "Descargar SRT" que
 * produce un fichero vacio es peor que un boton gris: el usuario no sabe si fallo o
 * si es que aun no ha hablado.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { download, render, suggestedName, type ExportFormat } from "@/lib/export";
import type { Block } from "@/lib/transcript";
import { clock, wordCount } from "@/lib/format";

export type ExportMenuProps = {
  blocks: readonly Block[];
  /** Texto abierto, que va al TXT pero no a los bloques. */
  interim: string;
  language: string;
  /** Fin de la sesion en ms de flujo. */
  endMs: number;
  onClear: () => void;
};

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: "txt", label: "Texto plano", hint: ".txt · frases separadas por linea" },
  { id: "md", label: "Markdown", hint: ".md · con marcas de tiempo" },
  { id: "srt", label: "Subtitulos SRT", hint: ".srt · numerado, con tiempos exactos" },
];

export function ExportMenu({ blocks, interim, language, endMs, onClear }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // El recuento de palabras y el estado de los botones miran tambien el texto
  // abierto: hay transcripcion en pantalla aunque no haya ninguna frase cerrada.
  const hasContent = blocks.length > 0 || interim.trim() !== "";
  const words = wordCount([...blocks.map((b) => b.text), interim].join(" "));

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // `pointerdown` y no `click`: si no, el clic que abrio el menu lo cerraria en el
    // mismo gesto.
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onExport = useCallback(
    (format: ExportFormat) => {
      if (format !== "txt" && blocks.length === 0) return;
      const contents = render(format, {
        blocks,
        interim,
        meta: {
          language,
          durationMs: endMs,
          exportedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
        },
      });
      download(format, contents, suggestedName());
      setOpen(false);
    },
    [blocks, endMs, interim, language],
  );

  return (
    <div ref={root} className="flex items-center gap-2">
      <span className="font-mono text-xs text-neutral-500 tabular-nums">
        {words} {words === 1 ? "palabra" : "palabras"}
        {endMs > 0 && <span className="ml-2 text-neutral-600">{clock(endMs)}</span>}
      </span>

      <button
        type="button"
        onClick={() => setConfirmingClear(true)}
        disabled={!hasContent}
        className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400
                   transition-colors hover:border-red-900 hover:bg-red-950/40 hover:text-red-300
                   disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-800
                   disabled:hover:bg-transparent disabled:hover:text-neutral-400"
      >
        Limpiar
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={!hasContent}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex items-center gap-1.5 rounded-md border border-neutral-800 px-3 py-1.5
                     text-xs text-neutral-200 transition-colors hover:border-neutral-700 hover:text-white
                     disabled:cursor-not-allowed disabled:opacity-40"
        >
          Descargar
          <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
            <path d="M6 8.5 2 4.5h8z" />
          </svg>
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-lg
                       border border-neutral-800 bg-neutral-900 shadow-2xl"
          >
            {FORMATS.map((format) => {
              // TXT si puede llevar el parcial abierto; Markdown y SRT necesitan
              // frases cerradas, porque un SRT con medio bloque no tiene sentido.
              const disabled = format.id !== "txt" && blocks.length === 0;
              return (
                <button
                  key={format.id}
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  onClick={() => onExport(format.id)}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left
                             transition-colors hover:bg-neutral-800
                             disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <span className="text-xs text-neutral-100">{format.label}</span>
                  <span className="text-[10px] text-neutral-500">{format.hint}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {confirmingClear && (
        <ConfirmDialog
          onCancel={() => setConfirmingClear(false)}
          onConfirm={() => {
            onClear();
            setConfirmingClear(false);
          }}
        />
      )}
    </div>
  );
}

function ConfirmDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirm.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-6"
      // El clic en el fondo cierra; el interior para que no. `onClick` con
      // `stopPropagation` es mas simple que comparar el target en cada rama.
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="limpiar-titulo"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl"
      >
        <h2 id="limpiar-titulo" className="text-sm font-medium text-neutral-100">
          Limpiar la transcripcion
        </h2>
        <p className="mt-2 text-xs leading-5 text-neutral-400">
          Se borra todo el texto de la sesion y lo que habia guardado en el navegador.
          Esto no se puede deshacer: descarga antes lo que te interese.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300
                       transition-colors hover:border-neutral-700 hover:text-white"
          >
            Cancelar
          </button>
          <button
            ref={confirm}
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white
                       transition-colors hover:bg-red-500"
          >
            Limpiar
          </button>
        </div>
      </div>
    </div>
  );
}
