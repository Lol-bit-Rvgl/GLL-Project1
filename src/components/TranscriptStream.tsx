"use client";

/**
 * Canal de texto: bloques consolidados y el segmento en curso.
 *
 * # El autoscroll
 *
 * Se decide con la posicion real del scroll, no con "el usuario hizo scroll", porque
 * el texto nuevo tambien desplaza el scroll sin que el usuario haga nada. `onScroll`
 * compara contra `scrollHeight`: si queda mas de 48 px de margen, el usuario esta
 * mas arriba y se suelta el "pegado". En cuanto vuelve al fondo, se vuelve a pegar
 * solo, sin que tenga que tocar nada.
 *
 * # Por que el parcial no re-pinta el historial
 *
 * El texto en curso va en un nodo aparte del historial. Un parcial cambia `interim` y
 * nada mas, asi que React solo toca la ultima linea. Es lo que evita el tirón cuando
 * entra una frase de 30 palabras en mitad de la sesion.
 */

import { memo, useCallback, useLayoutEffect, useRef } from "react";

import { clock } from "@/lib/format";
import type { Block } from "@/lib/transcript";

/** Margen bajo el cual se considera que el usuario esta "al final". */
const BOTTOM_SLACK_PX = 48;

export type TranscriptStreamProps = {
  blocks: readonly Block[];
  /** Texto del segmento en curso. */
  interim: string;
  /** `true` si hay una frase abierta. */
  speaking: boolean;
  /** `true` si el autoscroll esta pegado al final. */
  stickToBottom: boolean;
  /** Informa de si el usuario esta al final o ha subido a releer. */
  onStickChange: (stick: boolean) => void;
  /** Estado del motor, para el mensaje de reposo. */
  engineReady: boolean;
  /** `true` si hay captura. */
  capturing: boolean;
};

function TranscriptStreamImpl({
  blocks,
  interim,
  speaking,
  stickToBottom,
  onStickChange,
  engineReady,
  capturing,
}: TranscriptStreamProps) {
  const scroller = useRef<HTMLDivElement>(null);

  // `useLayoutEffect` y no `useEffect`: el scroll tiene que estar puesto ANTES de
  // que el navegador pinte, o se ve un salto desde arriba en cada frase nueva. Con
  // `auto` y no `smooth`, porque con texto cada 500 ms la animacion se solaparia
  // consigo misma y el texto rebotaria.
  useLayoutEffect(() => {
    if (!stickToBottom) return;
    const node = scroller.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [blocks, interim, stickToBottom]);

  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (node === null) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLACK_PX;
    onStickChange(atBottom);
  }, [onStickChange]);

  const empty = blocks.length === 0 && interim.trim() === "";

  return (
    <section className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5"
      >
        {empty ? (
          <EmptyState capturing={capturing} engineReady={engineReady} />
        ) : (
          <>
            {blocks.map((block) => (
              <p key={block.id} className="mb-3 text-[1.0625rem] leading-7">
                <span className="mr-3 select-none font-mono text-xs text-neutral-600 tabular-nums">
                  {clock(block.startMs)}
                </span>
                <span className="text-neutral-100">{block.text}</span>
              </p>
            ))}
            {speaking && (
              <p className="text-[1.0625rem] leading-7 text-sky-200/80">
                {interim.trim() === "" ? (
                  <span className="caret" />
                ) : (
                  <>
                    <span className="select-none whitespace-pre-wrap">{interim}</span>
                    <span className="caret" />
                  </>
                )}
              </p>
            )}
          </>
        )}
      </div>

      {/* El boton solo aparece cuando el usuario se ha soltado del final. Flotante y
          pequeno, para no comer altura del canal de texto. */}
      {!stickToBottom && !empty && (
        <button
          type="button"
          onClick={() => onStickChange(true)}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-neutral-700
                     bg-neutral-900/90 px-3 py-1.5 text-xs text-neutral-200 shadow-lg
                     backdrop-blur transition-colors hover:border-neutral-500 hover:text-white
                     focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          Bajar al final
        </button>
      )}
    </section>
  );
}

function EmptyState({ capturing, engineReady }: { capturing: boolean; engineReady: boolean }) {
  const message = !capturing
    ? "Sin captura activa. Pulsa Iniciar para escuchar."
    : !engineReady
      ? "Escuchando, pero el motor no esta listo. Revisa el modelo en la barra de arriba."
      : "Escuchando. Empieza a hablar y el texto aparecera aqui.";
  return (
    <div className="flex h-full min-h-48 items-center justify-center">
      <p className="max-w-sm text-center text-sm text-neutral-500">{message}</p>
    </div>
  );
}

export const TranscriptStream = memo(TranscriptStreamImpl);
