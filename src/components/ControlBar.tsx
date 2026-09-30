"use client";

/**
 * Barra superior: marca, conmutador de fuente y control de captura.
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
 *
 * # El indicador del conmutador se mueve con `transform`
 *
 * Un `left` animado por transicion de CSS recalcula la composicion en cada frame, y
 * esta barra esta en la misma pagina que la transcripcion, que ya compite con el STT
 * por el hilo principal. `translateX` lo resuelve el compositor con una matriz.
 *
 * La posicion sale de las props, sin estado ni efecto: `source` ya es la verdad, y
 * duplicarla en un `useState` obligaria a mantener dos copias que algun momento
 * dejarian de cuadrar.
 */

import type { AudioSource, EnginePhase } from "@/lib/types";

export type ControlBarProps = {
  phase: EnginePhase;
  source: AudioSource;
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
  busy,
  engineReady,
  modelReady,
  downloading,
  speaking,
  duckMusic,
  onToggle,
  onSourceChange,
  onDownloadModel,
  onDuckMusicChange,
}: ControlBarProps) {
  const live = phase !== "reposo";

  return (
    /*
     * Tres grupos, no uno.
     *
     * Con todo en un solo `flex-wrap`, a 1000 px de ancho el elemento con `ml-auto` (la
     * marca) se caia a una TERCERA fila solo, y la cabecera pasaba de 46 a 93 px: el 13 %
     * de la ventana para cromo, con el canal de textoStripped por el medio. Medido con
     * CDP, no estimado.
     *
     * Separando en marca / captura / ajustes, lo que no cabe se va a una segunda fila
     * entera y equilibrada, y la marca se queda arriba a la izquierda. `justify-between`
     * reparte el sobrante en vez de acumularlo delante de un `ml-auto`, que es lo que
     * empujaba la marca al desborde.
     */
    <header className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2
                        border-b border-neon/12 bg-panel/80 px-6 py-2.5 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <span className="text-sm font-semibold tracking-tight text-snow">LyricStream STT</span>
        <span
          className="rounded border border-neon/30 bg-neon/[0.07] px-1.5 py-0.5
                     font-mono text-[10px] leading-none tracking-wide text-flare"
          title="Hecho por GLL"
        >
          by GLL
        </span>
      </div>

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
          {live ? (
            <span className="live-dot" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
              <path d="M4 2.5v11l9-5.5z" />
            </svg>
          )}
          {live ? "TRANSCRIBIENDO EN VIVO" : "Iniciar"}
        </button>

        <StatusPill phase={phase} speaking={speaking} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SourceSwitch value={source} disabled={busy || live} onChange={onSourceChange} />

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
          <span className="text-xs text-gold/80">Inferencia no disponible</span>
        )}

        {/*
          El silencio automatico es una opcion, no un comportamiento: hay gente que
          transcribe reuniones con musica de fondo de proposito. Vive en la barra y no
          en el reproductor porque lo decide quien va a transcribir, no quien esta
          escuchando.

          El texto corto cabe en la segunda fila de la cabecera a 1000 px; el largo
          ("al transcribir") no, y empujaba el resto de la barra a una fila mas. El
          matiz entero sigue en el `title` y en el `aria-label`, que es donde se busca
          cuando la etiqueta no cabe.
        */}
        <label
          title="Baja la musica mientras transcribe, y la vuelve a subir al terminar"
          className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-ink hover:text-snow"
        >
          <input
            type="checkbox"
            checked={duckMusic}
            onChange={(event) => onDuckMusicChange(event.target.checked)}
            aria-label="Silenciar la musica mientras transcribe"
            className="h-3.5 w-3.5 cursor-pointer accent-neon"
          />
          Silenciar musica
        </label>
      </div>
    </header>
  );
}

/**
 * Conmutador de fuente, dos estados, indicador deslizante.
 *
 * No es un `<select>` porque el texto es largo ("Sistema (Loopback)" frente a
 * "Microfono") y un desplegable nativo lo recorta en un portatil estrecho. Ademas el
 * estado se ve de un vistazo sin pinchar, que es justo lo que se necesita antes de
 * arrancar: con loopback entra en la transcripcion todo lo que suene.
 */
function SourceSwitch({
  value,
  disabled,
  onChange,
}: {
  value: AudioSource;
  disabled: boolean;
  onChange: (source: AudioSource) => void;
}) {
  const mic = value === "mic";
  return (
    <div
      role="radiogroup"
      aria-label="Fuente de audio"
      className="relative flex items-center rounded-full border border-neon/20 bg-raised p-0.5"
    >
      {/* Indicador: la mitad de ancho, desplazada con `translateX` al 100 % cuando
          toca el segundo estado. Sin transicion de `left`, por lo mismo que el giro
          de la caratula y las barras del vumetro. */}
      <span
        aria-hidden="true"
        className={`absolute inset-y-0.5 left-0.5 w-[calc(50%-0.25rem)] rounded-full
                    bg-gradient-to-b from-orange-600/70 to-amber-500/50 ring-1 ring-neon/40
                    transition-transform duration-200 ease-out ${
                      mic ? "translate-x-[calc(100%+0.25rem)]" : "translate-x-0"
                    }`}
      />
      <SwitchOption
        active={!mic}
        disabled={disabled}
        onClick={() => onChange("loopback")}
        title="Captura lo que reproduce el sistema"
      >
        Sistema (Loopback)
      </SwitchOption>
      <SwitchOption
        active={mic}
        disabled={disabled}
        onClick={() => onChange("mic")}
        title="Captura el microfono"
      >
        Microfono
      </SwitchOption>
    </div>
  );
}

function SwitchOption({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`relative z-10 rounded-full px-3 py-1.5 text-xs
                  transition-colors duration-200
                  disabled:cursor-not-allowed disabled:opacity-50 ${
                    active ? "text-snow" : "text-slate-ink hover:text-snow"
                  }`}
    >
      {children}
    </button>
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
