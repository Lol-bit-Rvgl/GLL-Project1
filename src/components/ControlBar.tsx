"use client";

/**
 * Barra superior: control de captura, origen, idioma y estado.
 *
 * # Un solo boton, no dos
 *
 * La UI anterior tenia "Iniciar captura" y "Iniciar STT" como botones separados, lo
 * que obligaba al usuario a entender que el segundo depende del primero. Aqui hay un
 * boton que hace las dos cosas en orden, y el texto dice en que estado esta. Es la
 * diferencia entre una app que se usa y una que hay que recordar.
 *
 * El estado se lee del backend, no de un `useState` propio: si el comando falla a
 * mitad (por ejemplo, el modelo no esta), la fase se recalcula sola y la UI no
 * muestra "transcribiendo" cuando no lo esta.
 */

import type { AudioSource, EnginePhase, Language } from "@/lib/types";

export type ControlBarProps = {
  phase: EnginePhase;
  source: AudioSource;
  language: Language;
  /** `true` si hay una accion en curso. */
  busy: boolean;
  /** `true` si el motor hace inferencia real. */
  engineReady: boolean;
  /** `true` si el modelo esta instalado y verificado. */
  modelReady: boolean;
  /** `true` si hay una descarga en curso. */
  downloading: boolean;
  /** Frase abierta ahora mismo. */
  speaking: boolean;
  onToggle: () => void;
  onSourceChange: (source: AudioSource) => void;
  onLanguageChange: (language: Language) => void;
  onDownloadModel: () => void;
};

const PHASE_LABEL: Record<EnginePhase, string> = {
  reposo: "Reposo",
  capturando: "Capturando",
  transcribiendo: "Transcribiendo",
};

export function ControlBar({
  phase,
  source,
  language,
  busy,
  engineReady,
  modelReady,
  downloading,
  speaking,
  onToggle,
  onSourceChange,
  onLanguageChange,
  onDownloadModel,
}: ControlBarProps) {
  const live = phase !== "reposo";
  const mainLabel = live ? "Pausar" : "Iniciar";

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-neutral-800 bg-neutral-950/80 px-6 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          aria-label={live ? "Pausar la transcripcion" : "Iniciar la transcripcion"}
          className="group flex items-center gap-2.5 rounded-md bg-white px-4 py-2 text-sm font-medium
                     text-neutral-900 transition-transform hover:bg-neutral-200 active:scale-[0.98]
                     disabled:cursor-not-allowed disabled:opacity-50"
        >
          {/* Icono de pausa/reproducir en SVG puro: no depende de una libreria de
              iconos para dos triangulos, y no hereda el `currentColor` de forma
              inesperada. */}
          {live ? (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
              <rect x="4" y="3" width="3" height="10" rx="1" />
              <rect x="9" y="3" width="3" height="10" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
              <path d="M4 2.5v11l9-5.5z" />
            </svg>
          )}
          {mainLabel}
        </button>

        <StatusPill phase={phase} speaking={speaking} />
      </div>

      <div className="flex items-center gap-3">
        <Field label="Fuente">
          <select
            value={source}
            disabled={busy || live}
            onChange={(event) => onSourceChange(event.target.value as AudioSource)}
            className={selectClass}
          >
            <option value="loopback">Audio del sistema</option>
            <option value="mic">Microfono</option>
          </select>
        </Field>

        <Field label="Idioma">
          <select
            value={language}
            disabled={busy}
            onChange={(event) => onLanguageChange(event.target.value as Language)}
            className={selectClass}
          >
            <option value="auto">Automatico</option>
            <option value="es">Espanol</option>
            <option value="en">Ingles</option>
          </select>
        </Field>

        {!modelReady && (
          <button
            type="button"
            onClick={onDownloadModel}
            disabled={busy || downloading}
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5
                       text-xs text-amber-200 transition-colors hover:bg-amber-500/20
                       disabled:cursor-not-allowed disabled:opacity-50"
          >
            {downloading ? "Descargando modelo..." : "Descargar modelo"}
          </button>
        )}

        {live && !engineReady && (
          <span className="text-xs text-amber-300/80">
            Inferencia no disponible
          </span>
        )}
      </div>
    </header>
  );
}

function StatusPill({
  phase,
  speaking,
}: {
  phase: EnginePhase;
  speaking: boolean;
}) {
  const dot =
    phase === "reposo" ? "bg-neutral-600" : speaking ? "bg-emerald-400" : "bg-sky-400";
  return (
    <span className="flex items-center gap-2 text-xs text-neutral-400" role="status">
      <span className="relative flex h-2 w-2">
        {/*
          Un halo que late solo cuando esta vivo. Con `animate-ping` de Tailwind sobre
          un elemento absoluto: el pulso no cambia el layout, que es lo que haria
          vibrar la barra entera.
        */}
        {phase !== "reposo" && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${dot}`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      {PHASE_LABEL[phase]}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-500">
      <span className="select-none">{label}</span>
      {children}
    </label>
  );
}

const selectClass =
  "rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 " +
  "transition-colors hover:border-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50";
