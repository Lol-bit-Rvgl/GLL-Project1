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
 * nada mas, asi que React solo toca la ultima linea. Es lo que evita el tiron cuando
 * entra una frase de 30 palabras en mitad de la sesion.
 *
 * # Por que `max-w-4xl` y centrado
 *
 * Una linea de texto de 144 caracteres a pantalla completa es incomoda de leer: el ojo
 * pierde el sitio al volver de una linea a la siguiente. Limitar el ancho hace que el
 * canal se lea como una columna, y de paso da un borde fijo al bloque para que la
 * fecha de la izquierda no dance de linea en linea.
 *
 * # Por que el bloque lleva borde y no padding de fecha
 *
 * Una columna de texto con el reloj en un `span` al principio obliga a reservar el hueco
 * con un margen, y ese hueco se ve como un canal vacio en las frases cortas. El borde
 * izquierdo con `pl-4` hace las dos cosas: marca la frase y separa el reloj, sin dejar
 * nada sin contenido en medio.
 *
 * # Donde NO esta el halo ambiental
 *
 * Vive una sola vez, en el `main` de `page.tsx`. Este componente no lo monta: dos capas
 * de `amber-pulse` respirando a la vez sobre el mismo sitio darian al ojo el doble de
 * resplandor del que pide el diseno, y ademas pagarian el pintado dos veces.
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
        className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5"
      >
        {empty ? (
          <EmptyState capturing={capturing} engineReady={engineReady} />
        ) : (
          <div className="mx-auto w-full max-w-4xl">
            {blocks.map((block) => (
              <div
                key={block.id}
                className="animate-[fade-in_260ms_ease-out] border-l-2 border-neon/40 pl-4
                           transition-colors duration-500 hover:border-neon/70"
              >
                <p className="mb-3 text-[1.0625rem] leading-7 text-snow">
                  {/* Sin el modificador de opacidad. Con `text-flare/60` el navegador
                      compone #ff9d00 al 60 % sobre obsidian y el timestamp acaba
                      pintandose #9c6108, que ya no es el ambar del tema y ademas se
                      queda en 3.92:1, por debajo del 4.5:1 que WCAG AA pide para texto
                      de 12 px. A opacidad plena son 9.55:1. Medido sobre la app en
                      ejecucion, no estimado. */}
                  <span className="mr-3 select-none font-mono text-xs text-flare tabular-nums">
                    {clock(block.startMs)}
                  </span>
                  {block.text}
                </p>
              </div>
            ))}
            {speaking && (
              <div className="border-l-2 border-neon/70 pl-4">
                <p className="text-[1.0625rem] leading-7 text-ember">
                  {interim.trim() === "" ? (
                    <span className="caret" />
                  ) : (
                    <>
                      <span className="select-none whitespace-pre-wrap">{interim}</span>
                      <span className="caret" />
                    </>
                  )}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* El boton solo aparece cuando el usuario se ha soltado del final. Flotante y
          pequeno, para no comer altura del canal de texto. */}
      {!stickToBottom && !empty && (
        <button
          type="button"
          onClick={() => onStickChange(true)}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-neon/30
                     bg-panel/90 px-3 py-1.5 text-xs text-snow shadow-lg
                     backdrop-blur transition-colors hover:border-neon/70 hover:text-white
                     focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
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
      <p className="max-w-sm text-center text-sm text-slate-ink/70">{message}</p>
    </div>
  );
}

export const TranscriptStream = memo(TranscriptStreamImpl);
