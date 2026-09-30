"use client";

/**
 * Reproductor acoplado a la barra inferior.
 *
 * Es el unico componente que llama a `useMusicPlayer` con el estado entero, asi que
 * es el unico que se repinta cuatro veces por segundo con la posicion del audio. Todo
 * lo de arriba -transcripcion, controles, cola- vive fuera de este subarbol y no nota
 * nada.
 *
 * # El aviso de loopback
 *
 * Va aqui y no en la barra de captura porque depende de las dos cosas: hay musica
 * sonando **y** la captura esta en modo sistema. Solo entonces tiene sentido, y las dos
 * se leen del mismo sitio. El texto esta en `captureConflict`, junto al motivo
 * tecnico, para que la razon y el aviso no se separen nunca.
 */

import { useRef, useState } from "react";

import { LanguageSwitch } from "@/components/LanguageSwitch";
import { DropZone } from "./DropZone";
import { QueueDrawer } from "./QueueDrawer";
import { Scrubber } from "./Scrubber";
import { VolumeControl } from "./VolumeControl";
import { AUDIO_EXTENSIONS, captureConflict } from "@/lib/player/types";
import type { Track } from "@/lib/player/types";
import type { AudioSource, Language } from "@/lib/types";
import {
  useMusicControls,
  useMusicPlayer,
  usePlayerError,
} from "@/lib/player/useMusicPlayer";

export type DockedPlayerProps = {
  /** Origen de la captura, para el aviso de loopback. */
  source: AudioSource;
  /** `true` mientras la captura esta activa. */
  capturing: boolean;
  /**
   * Idioma forzado de la transcripcion.
   *
   * Va en el dock y no en la barra de captura por medida, no por gusto: con el selector
   * en la cabecera, esta ocupaba 93 px en tres filas a 1000 px de ancho, con la marca
   * sola en la tercera, y el canal de texto se quedaba en 482 px. Bajandolo aqui, la
   * cabecera cabe en una fila y le devuelve 47 px al texto. Medido con CDP.
   *
   * Y es seguro aqui pese a que este subarbol se repinta cuatro veces por segundo: el
   * idioma cambia una vez cada varias frases, no cuatro veces por segundo. Lo que NO
   * se ha movido aqui es el menu de exportar, que lleva el recuento de palabras; eso si
   * cambiaria con la transcripcion y entraria en el repintado de la posicion del audio.
   */
  language: Language;
  onLanguageChange: (language: Language) => void;
  /** `true` si hay una accion de backend en curso. */
  busy: boolean;
};

export function DockedPlayer({
  source,
  capturing,
  language,
  onLanguageChange,
  busy,
}: DockedPlayerProps) {
  const state = useMusicPlayer();
  const commands = useMusicControls();
  const { message, dismiss } = usePlayerError();
  const [queueOpen, setQueueOpen] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const conflict = captureConflict(source, capturing, state.isPlaying);
  // El reposo se comprueba con `state.current === null` **en el JSX**, y no con un
  // `const idle` aparte, para que TypeScript estreche el tipo en la rama del
  // reproductor. Con el booleano por separado, `state.current` sigue siendo
  // `Track | null` dentro de la rama y no se puede pasar a un componente que exige
  // `Track` sin un `!` que aqui no se quiere.

  return (
    <DropZone onFiles={commands.addFiles}>
      {/*
        El input va aqui y no dentro de un boton: `HTMLInputElement.click()` desde
        otro elemento es lo que dispara el dialogo nativo, y el elemento tiene que
        existir en el DOM aunque no se vea. `accept` es una sugerencia para el dialogo
        y el filtro real lo pone `DropZone`/`tracksFromFiles`.
      */}
      <input
        ref={picker}
        type="file"
        accept={`audio/*,${AUDIO_EXTENSIONS.join(",")}`}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) void commands.addFiles(files);
          // Sin esto, elegir el mismo fichero dos veces seguidas no dispara el `change`:
          // el valor del input no cambia y el navegador no avisa.
          event.target.value = "";
        }}
      />

      {/*
        Panel flotante: `mx-4 mb-4` y esquinas redondeadas en vez de una franja pegada al
        borde con una linea de arriba. La diferencia no es decorativa: como el dock ya
        queda separado del resto por un margen, deja de leerse como el borde de la
        ventana y pasa a leerse como un objeto -un panel- que esta encima. Con la franja
        al borde, todo lo que habia dentro parecia parte del fondo.

        `overflow-hidden` recorta los bordes redondeados de los hijos. Sin el, el aviso de
        loopback y los mensajes de error se salen por las esquinas del panel en cuanto
        tienen fondo. Los hijos con `position: absolute` no se ven afectados: no hay
        ninguno dentro, el unicooverlay de la app va en un portal.
      */}
      <div className="mx-4 mb-4 overflow-hidden rounded-2xl border border-neon/15 bg-panel/80 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur">
        {conflict.warns && (
          <p
            role="status"
            className="border-b border-neon/20 bg-neon/[0.07] px-6 py-1.5 text-[11px] leading-4 text-ember"
          >
            {conflict.message}
          </p>
        )}

        {message !== null && (
          <p
            role="alert"
            className="flex items-center gap-2 border-b border-red-900/40 bg-red-950/25 px-6 py-1.5
                       text-[11px] text-red-300"
          >
            <span className="flex-1">{message}</span>
            <button
              type="button"
              onClick={dismiss}
              className="rounded px-1.5 py-0.5 text-red-200 transition-colors hover:bg-red-900/40"
            >
              Cerrar
            </button>
          </p>
        )}

        <div className="flex items-center gap-4 px-6 py-2.5">
          {state.current === null ? (
            <div className="flex flex-1 items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded bg-raised">
                <svg viewBox="0 0 16 16" className="h-4 w-4 fill-slate-ink" aria-hidden="true">
                  <path d="M13 2.5v8.2a2.3 2.3 0 1 1-1.5-2.15V5.2L6 6.1v6.4a2.3 2.3 0 1 1-1.5-2.15V4.4z" />
                </svg>
              </span>
              <p className="flex-1 text-xs text-slate-ink">
                Sin musica. Suelta ficheros en la ventana,{" "}
                <button
                  type="button"
                  onClick={() => picker.current?.click()}
                  className="text-gold underline decoration-neon/40 underline-offset-2 transition-colors hover:text-flare"
                >
                  abre el explorador
                </button>{" "}
                o{" "}
                <button
                  type="button"
                  onClick={() => setQueueOpen(true)}
                  className="text-gold underline decoration-neon/40 underline-offset-2 transition-colors hover:text-flare"
                >
                  pega una URL
                </button>
                .
              </p>
            </div>
          ) : (
            <>
              <div className="flex w-56 shrink-0 items-center gap-3">
                <Artwork track={state.current} playing={state.isPlaying} />
                <div className="min-w-0">
                  <p className="truncate text-xs text-snow">{state.current?.title}</p>
                  {state.current?.artist != null && (
                    <p className="truncate text-[10px] text-slate-ink">
                      {state.current.artist}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <TransportButton
                  label="Anterior"
                  onClick={commands.previous}
                  path="M12 3v10L6 8zM4 3h1.5v10H4z"
                />
                <button
                  type="button"
                  onClick={commands.toggle}
                  aria-label={state.isPlaying ? "Pausar" : "Reproducir"}
                  aria-pressed={state.isPlaying}
                  className="flex h-9 w-9 items-center justify-center rounded-full
                             bg-gradient-to-b from-orange-500 to-amber-500 text-white
                             shadow-[0_0_14px_rgba(255,107,0,0.35)] transition-transform
                             hover:shadow-[0_0_20px_rgba(255,107,0,0.55)] active:scale-95
                             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
                >
                  {state.isPlaying ? (
                    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
                      <rect x="4" y="3" width="3" height="10" rx="1" />
                      <rect x="9" y="3" width="3" height="10" rx="1" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
                      <path d="M4 2.5v11l9-5.5z" />
                    </svg>
                  )}
                </button>
                <TransportButton
                  label="Siguiente"
                  onClick={commands.next}
                  path="M4 3l6 5-6 5zM10.5 3H12v10h-1.5z"
                />
              </div>

              <Scrubber
                value={state.currentTime}
                max={state.duration}
                onSeek={commands.seek}
                className="min-w-0 flex-1"
              />
            </>
          )}

          <div className="flex shrink-0 items-center gap-2">
            {/* El idioma va el primero del grupo de la derecha: es lo que se cambia de
                verdad durante una sesion, y asi queda a la vista sin subir la barra. */}
            <LanguageSwitch value={language} disabled={busy} onChange={onLanguageChange} />

            {/*
              El boton de anadir tambien sale con musica sonando. Sin el, una vez en
              marcha la unica forma de ampliar la cola es soltar ficheros en la ventana,
              y eso solo funciona con el raton.
            */}
            <button
              type="button"
              onClick={() => picker.current?.click()}
              aria-label="Anadir ficheros de musica"
              title="Anadir ficheros"
              className="rounded-md border border-neon/20 px-2.5 py-1.5 text-xs text-slate-ink
                         transition-colors hover:border-neon/50 hover:text-snow"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
                <path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z" />
              </svg>
            </button>

            <button
              type="button"
              onClick={commands.toggleShuffle}
              aria-pressed={state.shuffle}
              aria-label="Aleatorio"
              title="Aleatorio"
              className={`rounded p-1.5 transition-colors ${
                state.shuffle ? "text-neon" : "text-slate-ink/60 hover:text-snow"
              }`}
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
                <path d="M1 3h3l7 10h3v2h-4L3 5H1zm12.5 0L16 5.5 13.5 8zM1 11h2.2l1.6-2.3 1 1.5-1 1.4H3L1.8 13H1z" />
              </svg>
            </button>

            <button
              type="button"
              onClick={commands.cycleRepeat}
              aria-label={`Repeticion: ${state.repeat}`}
              title={`Repeticion: ${repeatLabel(state.repeat)}`}
              className={`relative rounded p-1.5 transition-colors ${
                state.repeat === "off"
                  ? "text-slate-ink/60 hover:text-snow"
                  : "text-neon"
              }`}
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
                <path d="M4 3h8v2.2l2.3-2.3L16 4.5 12.3 2.3V4H2v5h2z" />
                <path d="M12 13H4v-2.2l-2.3 2.3L.5 11.5 4.3 13.7V12h10V7h-2z" />
              </svg>
              {state.repeat === "one" && (
                <span className="absolute -right-0.5 -top-0.5 rounded bg-neon px-0.5 text-[9px] font-bold text-obsidian">
                  1
                </span>
              )}
            </button>

            <VolumeControl
              volume={state.volume}
              isMuted={state.isMuted}
              onVolume={commands.setVolume}
              onToggleMute={commands.toggleMute}
              ducked={state.isDucked}
            />

            <button
              type="button"
              onClick={() => setQueueOpen(true)}
              disabled={state.queue.length === 0}
              aria-label={`Cola, ${state.queue.length} pistas`}
              className="flex items-center gap-1.5 rounded-md border border-neon/20 px-2.5 py-1.5
                         text-xs text-slate-ink transition-colors hover:border-neon/50 hover:text-snow
                         disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
                <path d="M2 3h2v10H2zm4 0h2v10H6zm4 0h4v10h-4z" />
              </svg>
              {state.queue.length}
            </button>
          </div>
        </div>
      </div>

      <QueueDrawer
        open={queueOpen}
        tracks={state.queue}
        currentId={state.current?.id ?? null}
        onClose={() => setQueueOpen(false)}
        onRemoveAt={commands.removeAt}
        onMove={commands.move}
        onClear={commands.clearQueue}
        onPick={(index) => {
          commands.playAt(index);
          setQueueOpen(false);
        }}
        onAddUrl={(url) => commands.addUrl(url)}
      />
    </DropZone>
  );
}

function TransportButton({
  label,
  onClick,
  path,
}: {
  label: string;
  onClick: () => void;
  path: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="rounded p-1.5 text-slate-ink transition-colors hover:text-snow
                 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  );
}

/**
 * Caratula como disco de vinilo.
 *
 * # Por que circular
 *
 * Un cuadrado de 40 px al lado de un icono de pausa es una foto de perfil: dice quien
 * canta, no que esta sonando. Con la caratula recortada en circulo, la ranura y el
 * punto central, el mismo elemento se lee como un disco girando, y el giro es la
 * senal de "esto esta en marcha" que el ojo capta sin leer nada.
 *
 * # Por que el punto central no gira
 *
 * El eje del disco esta fijo, no instalado en la portada. Da igual por donde se gire
 * el elemento -es una rotacion sobre el centro-, asi que se puede dibujar encima
 * como hermano y se mantiene quieto gratis, sin una contra-rotacion.
 *
 * # Por que `motion-safe`
 *
 * El giro solo se declara cuando el sistema no pide menos movimiento. Con
 * `prefers-reduced-motion` activo la pista se ve como una caratula normal, y el estado
 * "sonando" sigue estando en el boton de pausa y en el icono de la pista. Girar algo
 * de forma infinita es justo el patron que esa preferencia existe para desactivar.
 */
function Artwork({ track, playing }: { track: Track; playing: boolean }) {
  return (
    <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
      <span
        className={`flex h-10 w-10 items-center justify-center overflow-hidden rounded-full
                    ring-1 ring-neon/30 ${
                      playing ? "motion-safe:animate-[spin_4s_linear_infinite]" : ""
                    }`}
        style={{ background: "radial-gradient(circle at 50% 50%, #2a2f3a 0%, #101318 68%)" }}
      >
        {track.artwork != null ? (
          <img src={track.artwork} alt="" className="h-full w-full object-cover" />
        ) : (
          <svg viewBox="0 0 16 16" className="h-4 w-4 fill-slate-ink" aria-hidden="true">
            <path d="M13 2.5v8.2a2.3 2.3 0 1 1-1.5-2.15V5.2L6 6.1v6.4a2.3 2.3 0 1 1-1.5-2.15V4.4z" />
          </svg>
        )}
      </span>
      {/* El eje, encima y sin girar. `pointer-events-none` porque el disco no debe
          capturar el raton si alguien lo pulsa para buscarlo. */}
      <span
        className="pointer-events-none absolute h-1.5 w-1.5 rounded-full bg-obsidian ring-1 ring-neon/50"
        aria-hidden="true"
      />
    </span>
  );
}

function repeatLabel(repeat: "off" | "all" | "one"): string {
  if (repeat === "all") return "repetir todo";
  if (repeat === "one") return "repetir esta";
  return "sin repetir";
}
