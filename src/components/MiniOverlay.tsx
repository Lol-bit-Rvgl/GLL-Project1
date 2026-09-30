/**
 * UI del modo mini-ventana.
 *
 * # Que se ve y que no
 *
 * Solo el texto en vivo y el boton de captura, como pide el modo: la ventana esta
 * encima de otra aplicacion y a 450x250 no cabe nada mas. Se oculta la cabecera, el
 * dock del reproductor, el vumetro y el menu de exportar.
 *
 * # Por que el dock se oculta entero
 *
 * Un reproductor de musica dentro de una ventana de 450x250 encima de un navegador
 * taparia la mitad de lo que hay detras, y el usuario esta leyendo las notas, no
 * escuchando una cancion. Ademas, `DockedPlayer` tiene una fila de controles con
 * botones de 28 px: a ese ancho se salen de la ventana. Ocultarlo entero, en vez de
 * apretarlo, evita tener que decidir cual de los dos manda.
 *
 * # Por que el dock sigue montado y escondido con `hidden`
 *
 * Porque `useMusicPlayer` es un singleton con estado fuera de React, y la cancion
 * sigue sonando con la ventana en modo mini: quien la pone sigue oyendola mientras
 * transcribe. Desmontar el dock no pararia el audio, pero desmontarlo y volver a
 * montarlo perderia la posicion visible del scrubber al volver. Con `hidden`, el DOM
 * sigue ahi, el audio sigue sonando, y al salir la ventana el dock aparece donde
 * estaba.
 *
 * `hidden` y no `opacity-0` porque `opacity-0` deja el nodo ocupando sitio y aceptando
 * el foco del tabulador: un reproductor invisible al que se puede saltar con Tab es
 * peor que uno que no esta.
 */

/** Cuantas frases se ven como maximo en mini. */
export const MAX_FILAS_MINI = 6;

export type MiniOverlayProps = {
  /** Texto del segmento en curso, o el texto del ultimo bloque cerrado. */
  liveText: string;
  /** `true` si hay una frase abierta ahora mismo. */
  speaking: boolean;
  /** `true` si hay captura corriendo. */
  capturing: boolean;
  /** `true` si el motor esta listo de verdad. */
  engineReady: boolean;
  /** `true` si hay alguna frase en el historial. */
  hasText: boolean;
  /** Arranca o para captura y STT. */
  onToggle: () => void;
  /** Vuelve al modo normal. */
  onExit: () => void;
  /** Numero de frases marcadas. */
  bookmarks: number;
};

export function MiniOverlay({
  liveText,
  speaking,
  capturing,
  engineReady,
  hasText,
  onToggle,
  onExit,
  bookmarks,
}: MiniOverlayProps) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-obsidian/92 text-snow backdrop-blur-sm">
      {/*
        Cabecera minima: volver a la ventana normal y el estado. Sin marca y sin el
        selector de idioma, porque a 450 px de ancho esos dos se comen la mitad
        del ancho y lo que hace falta ahi es un boton de salida y un texto.
      */}
      <div className="flex items-center gap-2 border-b border-neon/12 px-3 py-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            speaking ? "live-dot bg-neon" : "bg-slate-ink/40"
          }`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-ink">
          {speaking ? "ESCUCHANDO" : capturing ? "CAPTURA ACTIVA" : "EN REPOSO"}
          {bookmarks > 0 && ` · ${bookmarks} 📌`}
        </span>
        <button
          type="button"
          onClick={onExit}
          title="Volver a la ventana completa"
          aria-label="Volver a la ventana completa"
          className="shrink-0 rounded border border-neon/25 px-1.5 py-0.5 text-[10px] text-slate-ink
                     transition-colors hover:border-neon/70 hover:text-snow
                     focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
        >
          Salir
        </button>
      </div>

      {/*
        El texto vivo, y solo el texto vivo.

        No es el historial recortado a seis filas: son las ULTIMAS frases, con la
        nueva arriba. En una ventana de 250 px de alto solo caben unas pocas lineas, y
        un historial que se pinta de abajo arriba obliga a hacer scroll hacia arriba para
        leer lo nuevo, que es lo contrario de lo que se quiere. Poner la frase nueva
        arriba hace que el ojo la encuentre sin moverse.

        El `text-balance` no se usa: con 450 px y palabras cortas no hay problema de
        orfandas, y el navegador equilibra solo cada parrafo, lo que con seis frases
        descoloca el ritmo del texto.
      */}
      <div className="min-h-0 flex-1 overflow-hidden px-3 py-2">
        {hasText ? (
          <p
            className="text-[0.8125rem] leading-5 text-snow"
            // El scroll esta en el contenedor, no en la frase: asi el texto largo se
            // recorta arriba, donde queda la frase mas reciente, en vez de abajo.
            style={{ overflow: "hidden" }}
          >
            {liveText}
            {speaking && <span className="caret" />}
          </p>
        ) : (
          <p className="text-center text-[0.8125rem] leading-5 text-slate-ink/70">
            {capturing
              ? "Escuchando. Empieza a hablar."
              : engineReady
                ? "Pulsa para empezar a capturar."
                : "El motor no esta listo."}
          </p>
        )}
      </div>

      {/*
        El boton de captura, a pantalla completa abajo.

        En el modo grande es un boton con texto y estado; aqui es el unico control, asi
        que ocupa el ancho entero y se le da 40 px de alto. Un boton de 28 px en una
        ventana que se usa con una mano, encima de otra aplicacion, fallaria la mitad
        de las veces.
      */}
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={capturing}
        title={capturing ? "Parar la transcripcion" : "Empezar a transcribir"}
        className={`mx-3 mb-3 flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg text-xs
                    font-semibold tracking-wide uppercase transition-colors
                    focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon
                    ${
                      capturing
                        ? "border border-neon/50 bg-neon/15 text-neon hover:bg-neon/25"
                        : "bg-gradient-to-b from-orange-600 to-amber-500 text-obsidian hover:from-orange-500 hover:to-amber-400"
                    }`}
      >
        {capturing ? (
          <>
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current" aria-hidden="true">
              <rect x="4" y="4" width="8" height="8" rx="1" />
            </svg>
            Detener
          </>
        ) : (
          <>
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current" aria-hidden="true">
              <path d="M4 2.5v11l9-5.5z" />
            </svg>
            Iniciar
          </>
        )}
      </button>
    </div>
  );
}
