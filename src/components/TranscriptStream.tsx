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

import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";

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

  /*
   * Frases que ya estaban escritas cuando el usuario se solto del final.
   *
   * `null` significa "pegado al final", o sea que no hay nada sin leer. Al soltarse se
   * fija al numero de bloques que hay en ese instante, y a partir de ahi el contador es
   * `blocks.length - anchor`, que crece solo con laProps.
   *
   * # Por que un ancla y no un contador
   *
   * Un contador de "nuevas" tendria que incrementarse cuando llega un bloque, y eso solo
   * se puede hacer desde un efecto sobre las props. Aqui el estado no cuenta: guarda el
   * punto de partida, y la cuenta se deriva durante el render. Consecuencia practica:
   * ningun `setState` vive en un efecto y el boton no necesita un temporizador ni una
   * bandera para saber si el numero es real.
   *
   * # Por que se fija al soltarse y no en cada scroll
   *
   * Si el ancla se moviera en cada evento de scroll, subir y bajar un poco lo pondria a
   * cero y el contador volveria a empezar. Solo se mueve al cruzar el umbral, que es lo
   * que el usuario percibe como "me he soltado".
   */
  const [anchor, setAnchor] = useState<number | null>(null);

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
    const count = blocks.length;
    setAnchor((prev) => {
      if (atBottom) return null;
      return prev === null ? count : prev;
    });
  }, [blocks.length, onStickChange]);

  const unread = anchor === null ? 0 : Math.max(0, blocks.length - anchor);

  const jumpToPresent = useCallback(() => {
    setAnchor(null);
    onStickChange(true);
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
                className="motion-safe:animate-[slide-up-fade_320ms_ease-out] border-l-2 border-neon/40 pl-4
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
                {/* El parcial va en `ember` a peso medio: es texto provisional, pero es la
                    unica version que hay de esa frase mientras whisper la cierra, asi que
                    no puede verse como un hueco. El cursor `caret` ya dice que esta en
                    curso; el color solo separa lo cerrado de lo abierto. */}
                <p className="text-[1.0625rem] font-medium leading-7 text-ember">
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

      {/*
        El boton solo aparece cuando el usuario se ha soltado del final, y va abajo a la
        derecha y en circulo. Antes estaba centrado, y tapaba la ultima frase justo
        cuando hay algo nuevo que leer; en una esquina no pisa nada. Y el contador va en
        una insignia encima, no dentro del boton: el icono sigue siendo un icono y el
        numero no le cambia la forma al pasar de 1 a 100.
      */}
      {!stickToBottom && !empty && (
        <button
          type="button"
          onClick={jumpToPresent}
          aria-label={
            unread > 0 ? `Ir al presente, ${unread} frases sin leer` : "Ir al presente"
          }
          title={unread > 0 ? `${unread} frases sin leer` : "Ir al presente"}
          className="motion-safe:animate-[slide-up-fade_260ms_ease-out] absolute bottom-4 right-6
                     flex h-10 w-10 items-center justify-center rounded-full border border-neon/40
                     bg-panel/90 text-snow shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur
                     transition-colors hover:border-neon hover:text-white
                     focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
            <path d="M8 2.5v8.2l3.4-3.4 1.1 1.1L8 12.8 3.5 8.4l1.1-1.1L8 10.7V2.5z" />
          </svg>
          {unread > 0 && (
            <span
              className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-neon px-1
                         font-mono text-[10px] font-bold leading-[18px] text-obsidian
                         tabular-nums ring-2 ring-obsidian"
              aria-hidden="true"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
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
