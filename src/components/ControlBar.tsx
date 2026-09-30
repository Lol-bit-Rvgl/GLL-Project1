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
  /** `true` si la musica se baja mientras transcribe. */
  duckMusic: boolean;
  onToggle: () => void;
  onSourceChange: (source: AudioSource) => void;
  onLanguageChange: (language: Language) => void;
  onDownloadModel: () => void;
  onDuckMusicChange: (duck: boolean) => void;
};

/**
 * Texto de la fase.
 *
 * Vive aqui y no se recalcula en el componente porque `StatusPill` distingue tambien
 * `speaking`, y duplicar las dos tablas haria que se desincronizasen en cuanto se
 * anadiera un estado.
 */
const PHASE_LABEL: Record<EnginePhase, string> = {
  reposo: "Reposo",
  capturando: "Escuchando",
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
  duckMusic,
  onToggle,
  onSourceChange,
  onLanguageChange,
  onDownloadModel,
  onDuckMusicChange,
}: ControlBarProps) {
  const live = phase !== "reposo";
  const mainLabel = live ? "Pausar" : "Iniciar";

  return (
    <header className="relative flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-neon/12 bg-panel/80 px-6 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        {/*
          El boton cambia de piel, no solo de color: en reposo es una placa oscura con
          borde de la marca, y en activo se enciende con el degradado y la sombra. La
          diferencia de *tratamiento* es lo que hace que se lea como un interruptor de
          verdad y no como un boton que ha cambiado de tono; si los dos estados fueran
          solo dos colores, con el brillo de la pantalla de un portatil no se
          distinguirian.
        */}
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          aria-label={live ? "Pausar la transcripcion" : "Iniciar la transcripcion"}
          className={`group relative flex items-center gap-2.5 rounded-md px-4 py-2 text-sm font-medium
                      transition-all duration-200 active:scale-[0.98]
                      disabled:cursor-not-allowed disabled:opacity-50 ${
                        live
                          ? "bg-gradient-to-b from-orange-600 to-amber-500 text-white shadow-[0_0_20px_rgba(255,107,0,0.4)] hover:shadow-[0_0_28px_rgba(255,107,0,0.55)]"
                          : "border border-neon/40 bg-raised text-snow hover:border-neon/80 hover:bg-neon/10"
                      }`}
        >
          {/* Icono de pausa/reproducir en SVG puro: no depende de una libreria de
              iconos para dos triangulos, y no hereda el `currentColor` de forma
              inesperada. */}
          {live ? (
            <span className="live-dot" aria-hidden="true" />
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
            className="rounded-md border border-neon/40 bg-neon/10 px-3 py-1.5
                       text-xs text-gold transition-colors hover:bg-neon/20
                       disabled:cursor-not-allowed disabled:opacity-50"
          >
            {downloading ? "Descargando modelo..." : "Descargar modelo"}
          </button>
        )}

        {live && !engineReady && (
          <span className="text-xs text-gold/80">
            Inferencia no disponible
          </span>
        )}

        {/*
          El silencio automatico es una opcion, no un comportamiento: hay gente que
          transcribe reuniones con musica de fondo de proposito. Vive en la barra y no
          en el reproductor porque lo decide quien va a transcribir, no quien esta
          escuchando.
        */}
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-ink hover:text-snow">
          <input
            type="checkbox"
            checked={duckMusic}
            onChange={(event) => onDuckMusicChange(event.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer accent-neon"
          />
          Silenciar musica al transcribir
        </label>
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
  // El color del punto dice que esta pasando el motor, no que hay una animacion: verde
  // cuando hay voz, ambar cuando la frase esta en curso, gris parado. Con el punto
  // apagado en reposo se evita el "esta vivo" en una app que no esta capturando.
  const dot = phase === "reposo" ? "bg-slate-ink/40" : speaking ? "bg-olive" : "bg-neon";
  return (
    <span
      className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-slate-ink"
      role="status"
    >
      {phase === "reposo" ? (
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      ) : speaking ? (
        // Con voz, el punto suelto se sustituye por tres barras desfasadas: el mismo
        // ritmo que el vumetro, y dice "esta sonando una frase" sin anadir texto.
        <span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
          <span className="eq-bar h-3 w-[3px] rounded-[1px] bg-olive" />
          <span className="eq-bar h-3 w-[3px] rounded-[1px] bg-neon" />
          <span className="eq-bar h-3 w-[3px] rounded-[1px] bg-flare" />
        </span>
      ) : (
        <span className="live-dot" aria-hidden="true" />
      )}
      {PHASE_LABEL[phase]}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-ink">
      <span className="select-none">{label}</span>
      {children}
    </label>
  );
}

const selectClass =
  "rounded-md border border-neon/15 bg-raised px-2.5 py-1.5 text-xs text-snow " +
  "transition-colors hover:border-neon/40 focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-neon disabled:cursor-not-allowed disabled:opacity-50";
