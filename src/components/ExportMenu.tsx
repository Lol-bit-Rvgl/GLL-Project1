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
import { createPortal } from "react-dom";

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
          // ISO completo y sin recortar: el formato de la fecha lo pone `dateStamp`, que
          // necesita la zona local. Recortar aqui devolvia la hora de UTC en la cabecera.
          exportedAt: new Date().toISOString(),
        },
      });
      download(format, contents, suggestedName());
      setOpen(false);
    },
    [blocks, endMs, interim, language],
  );

  return (
    <div ref={root} className="flex items-center gap-2">
      <span className="font-mono text-xs text-slate-ink tabular-nums">
        {words} {words === 1 ? "palabra" : "palabras"}
        {endMs > 0 && <span className="ml-2 text-slate-ink/70">{clock(endMs)}</span>}
      </span>

      <button
        type="button"
        onClick={() => setConfirmingClear(true)}
        disabled={!hasContent}
        className="rounded-md border border-neon/15 px-3 py-1.5 text-xs text-slate-ink
                   transition-colors hover:border-red-900/60 hover:bg-red-950/30 hover:text-red-300
                   disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neon/15
                   disabled:hover:bg-transparent disabled:hover:text-slate-ink"
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
          className="flex items-center gap-1.5 rounded-md border border-neon/20 px-3 py-1.5
                     text-xs text-snow transition-colors hover:border-neon/60 hover:text-gold
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
            className="absolute right-0 z-20 mt-1 w-60 origin-top-right overflow-hidden rounded-lg
                       border border-neon/20 bg-raised shadow-2xl
                       motion-safe:animate-[slide-up-fade_180ms_ease-out]"
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
                             transition-colors hover:bg-neon/10
                             disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <span className="text-xs text-snow">{format.label}</span>
                  <span className="text-[10px] text-slate-ink">{format.hint}</span>
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

/**
 * Confirmacion de "Limpiar", en un portal sobre `document.body`.
 *
 * # Por que un portal y no aqui dentro
 *
 * Este dialogo es `position: fixed` y quiere cubrir la ventana entera, pero el `footer`
 * que lo contiene tiene `backdrop-blur`. Cualquier ancestro con `backdrop-filter` se
 * convierte en bloque contenedor de los descendientes fijos, igual que pasa con
 * `transform` y con `filter`: el `fixed` deja de medir contra la ventana y mide contra
 * ese ancestro. El resultado es un fondo opaco del alto de una franja de 40 px pegada
 * abajo y un recuadro centrado en ella, que es un boton flotando con su sombra pero sin
 * modal alrededor. El overlay de `DropZone` tiene el mismo problema y lo resuelve igual,
 * con `createPortal`.
 *
 * Solo se monta tras un clic, o sea ya en el cliente, asi que `document` existe: no hace
 * falta bandera de "montado" ni IIFE asincrono, y el primer render coincide con el del
 * servidor.
 */
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

  return createPortal(
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-obsidian/80 p-6
                 motion-safe:animate-[fade-in_200ms_ease-out]"
      // El clic en el fondo cierra; el interior para que no. `onClick` con
      // `stopPropagation` es mas simple que comparar el target en cada rama.
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="limpiar-titulo"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-neon/20 bg-panel p-5 shadow-2xl
                   motion-safe:animate-[slide-up-fade_260ms_ease-out]"
      >
        <h2 id="limpiar-titulo" className="text-sm font-medium text-snow">
          Limpiar la transcripcion
        </h2>
        <p className="mt-2 text-xs leading-5 text-slate-ink">
          Se borra todo el texto de la sesion y lo que habia guardado en el navegador.
          Esto no se puede deshacer: descarga antes lo que te interese.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-neon/20 px-3 py-1.5 text-xs text-snow
                       transition-colors hover:border-neon/50 hover:text-gold"
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
    </div>,
    document.body,
  );
}
