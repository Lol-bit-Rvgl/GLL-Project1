"use client";

/**
 * Canal de texto: bloques consolidados, el segmento en curso, marcadores y busqueda.
 *
 * # El autoscroll
 *
 * Se decide con la posicion real del scroll, no con "el usuario hizo scroll", porque
 * el texto nuevo tambien desplaza el scroll sin que el usuario haga nada. `onScroll`
 * compara contra `scrollHeight`: si queda mas de 48 px de margen, el usuario esta
 * mas arriba y se suelta el "pegado". En cuanto vuelve al fondo, se vuelve a pegar
 * solo, sin que tenga que tocar nada.
 *
 * # El contador de frases sin leer se DERIVA
 *
 * El estado guarda el ANCLA (cuantos bloques habia cuando el usuario se solto del
 * final) y el numero sale de `blocks.length - anchor` durante el render. Un contador de
 * verdad tendria que incrementarse al llegar un bloque, y eso solo se puede hacer desde
 * un efecto: un `setState` por frase, que ademas pinta el historial entero una vez mas.
 * El ancla solo se mueve al CRUZAR el umbral, no en cada evento de scroll, o subir y
 * bajar un poco lo pondria a cero.
 *
 * # La ventana de renderizado no mueve el scroll
 *
 * Por encima de 150 bloques solo se pintan los que caben mas un margen, y el hueco se
 * cubre con dos espaciadores de altura calculada (`planVentana`, en `src/lib/windowing.ts`).
 * La ALTURA TOTAL no cambia nunca, que es lo importante: si colapsaramos el historial
 * viejo, el usuario que esta leyendo la mitad veria como le salta el texto debajo. El
 * alto por bloque es una estimacion, no una medida, asi que el pulgar puede no caer
 * exactamente sobre la ultima frase.
 *
 * El rango se recalcula en el manejador de scroll, y SOLO se publica como estado cuando
 * cambia de verdad (`mismaVentana`): si no, cada pixel de scroll pintaria el historial
 * entero, que es justo lo que la ventana evita.
 *
 * # El resaltado no re-renderiza el reducer
 *
 * Las partes se trocean con `highlight` (`src/lib/search.ts`), que es lineal y no usa
 * `RegExp`: un buscador con `new RegExp(texto, "gi")` es un ReDoS esperando a ocurrir y
 * corre en el mismo hilo que pinta la transcripcion. El timestamp y el texto se
 * separan ANTES de trocear, para que una coincidencia en el reloj no se cuele
 * dentro de la palabra.
 *
 * # Un atajo, no un boton por cada cosa
 *
 * `Ctrl+B` marca y `Ctrl+F` busca. Los dos tienen ademas su boton, porque un atajo sin
 * boton no se descubre y un boton sin atajo no se usa con el teclado. Al abrir el
 * buscador el foco va al campo, lo mismo con el boton que con `Ctrl+F`, para que
 * escribir funcione sin un clic extra.
 */

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { clock } from "@/lib/format";
import { SearchBar } from "@/components/SearchBar";
import { highlight } from "@/lib/search";
import { ALTO_BLOQUE_ESTIMADO, mismaVentana, planVentana, ventanaCompleta } from "@/lib/windowing";
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
  /** Texto del buscador. Cadena vacia cuando esta cerrado. */
  query: string;
  /** Fija el texto del buscador. */
  setQuery: (value: string) => void;
  /** `true` si el buscador esta abierto. Sube al recibir el atajo o el boton. */
  searchOpen: boolean;
  /** Numero de coincidencias del historial entero, para la etiqueta. */
  matchCount: number;
  /** Marca o desmarca el bloque, en el historial. */
  onToggleBookmark: (id: number) => void;
  /** Cierra el buscador con Escape. */
  onDismissSearch: () => void;
};

function TranscriptStreamImpl({
  blocks,
  interim,
  speaking,
  stickToBottom,
  onStickChange,
  engineReady,
  capturing,
  query,
  setQuery,
  searchOpen,
  matchCount,
  onToggleBookmark,
  onDismissSearch,
}: TranscriptStreamProps) {
  const scroller = useRef<HTMLDivElement>(null);

  /*
   * Frases que ya estaban escritas cuando el usuario se solto del final.
   *
   * `null` significa "pegado al final", o sea que no hay nada sin leer. Al soltarse se
   * fija al numero de bloques que hay en ese instante, y a partir de ahi el contador es
   * `blocks.length - anchor`, que crece solo con las props.
   */
  const [anchor, setAnchor] = useState<number | null>(null);

  // Rango de bloques pintados. Se publica desde el manejador de scroll y desde el
  // efecto de pegado, nunca en el cuerpo del render.
  //
  // No lleva un `ref` espejo: el `setRango` funcional recibe el valor anterior, y eso es
  // lo que se compara contra el plan nuevo (`mismaVentana`). Un espejo escrito en el
  // render seria justo lo que la regla `react-hooks/refs` prohibe, y no hacia falta.
  const [rango, setRango] = useState(() => ventanaCompleta(0));

  // `buscando` es "hay texto escrito" y `barAbierto` es "el buscador esta visible". No
  // son lo mismo: se puede tener el buscador abierto y el campo vacio, que es
  // precisamente el estado en el que se empieza a escribir.
  const buscando = query.trim() !== "";
  // Con el buscador abierto se pinta el historial entero: el usuario esta leyendo
  // resultados, no scrolleando, y un texto que se recorta mientras busca parece que no
  // encuentra lo que hay. El coste de memoria es el que es, y esta acotado por el texto
  // que el usuario ha pedido ver.
  const ventana = buscando ? ventanaCompleta(blocks.length) : rango;

  // `useLayoutEffect` y no `useEffect`: el scroll tiene que estar puesto ANTES de
  // que el navegador pinte, o se ve un salto desde arriba en cada frase nueva. Con
  // `auto` y no `smooth`, porque con texto cada 500 ms la animacion se solaparia
  // consigo misma y el texto rebotaria.
  useLayoutEffect(() => {
    if (!stickToBottom) return;
    const node = scroller.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
    setRango((prev) => {
      const siguiente = planVentana(
        blocks.length,
        node.scrollTop,
        node.clientHeight,
        ALTO_BLOQUE_ESTIMADO,
      );
      if (mismaVentana(prev, siguiente)) return prev;
      return siguiente;
    });
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
    setRango((prev) => {
      const siguiente = planVentana(count, node.scrollTop, node.clientHeight, ALTO_BLOQUE_ESTIMADO);
      if (mismaVentana(prev, siguiente)) return prev;
      return siguiente;
    });
  }, [blocks.length, onStickChange]);

  const onKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        onDismissSearch();
      }
    },
    [searchOpen, onDismissSearch],
  );

  const unread = anchor === null ? 0 : Math.max(0, blocks.length - anchor);

  const jumpToPresent = useCallback(() => {
    setAnchor(null);
    onStickChange(true);
  }, [onStickChange]);

  const empty = blocks.length === 0 && interim.trim() === "";

  return (
    <section className="relative flex min-h-0 flex-1 flex-col">
      {searchOpen && (
        <SearchBar
          query={query}
          setQuery={setQuery}
          matchCount={matchCount}
          onClose={onDismissSearch}
          open={searchOpen}
        />
      )}

      <div
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={onKey}
        className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5"
      >
        {empty ? (
          <EmptyState capturing={capturing} engineReady={engineReady} />
        ) : (
          <div className="mx-auto w-full max-w-4xl">
            {ventana.arribaPx > 0 && (
              <div style={{ height: ventana.arribaPx }} aria-hidden="true" />
            )}

            {blocks.slice(ventana.from, ventana.to).map((block) => (
              <BlockRow
                key={block.id}
                block={block}
                query={query}
                onToggle={onToggleBookmark}
              />
            ))}

            {ventana.abajoPx > 0 && (
              <div style={{ height: ventana.abajoPx }} aria-hidden="true" />
            )}

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

/**
 * Una fila del historial: reloj, texto, resaltado y bandera.
 *
 * Va en su propio componente para que el resaltado no re-renderice el canal entero. Con
 * el buscador abierto solo cambian las filas que contienen la palabra, y como `block`
 * es una referencia distinta solo en esas, React no toca el resto. El `memo` es lo que
 * hace que eso sea cierto: sin el, el padre re-renderiza y todos los hijos tambien.
 *
 * El acento de bloque marcado es `border-flare` sobre `bg-flare/[0.07]`, que es el
 * ambar del tema a plena intensidad. Con la rampa cruda de Tailwind (`border-amber-400
 * bg-amber-500/10`) el resultado se pareceria, pero `AGENTS.md` explica que los tokens
 * existen justo para que nadie escriba `amber-400` en un sitio y `orange-500` en otro
 * pensando que son el mismo color, y este repo verifica la hoja generada contra los
 * tokens.
 */
const BlockRow = memo(function BlockRow({
  block,
  query,
  onToggle,
}: {
  block: Block;
  query: string;
  onToggle: (id: number) => void;
}) {
  const partes = useMemo(() => highlight(block.text, query), [block.text, query]);
  const marcado = block.bookmarked === true;

  return (
    <div
      data-bloque={block.id}
      className={`group relative motion-safe:animate-[slide-up-fade_320ms_ease-out] border-l-2 pl-4
                  transition-colors duration-500 ${
                    marcado
                      ? "border-flare bg-flare/[0.07] hover:border-flare"
                      : "border-neon/40 hover:border-neon/70"
                  }`}
    >
      <p className="mb-3 text-[1.0625rem] leading-7 text-snow">
        {/* Sin el modificador de opacidad. Con `text-flare/60` el navegador compone
            #ff9d00 al 60 % sobre obsidian y el timestamp acaba pintandose #9c6108, que
            ya no es el ambar del tema y ademas se queda en 3.92:1, por debajo del 4.5:1
            que WCAG AA pide para texto de 12 px. A opacidad plena son 9.55:1. Medido
            sobre la app en ejecucion, no estimado. */}
        <span className="mr-3 select-none font-mono text-xs text-flare tabular-nums">
          {clock(block.startMs)}
        </span>
        {partes === null ? (
          block.text
        ) : (
          partes.map((parte, i) =>
            parte.hit ? (
              // `mark` no es decoracion: es el resultado de la busqueda que el usuario
              // acaba de pedir, asi que va con su fondo y su `rounded`. Se usa el ambar
              // solido del tema sobre el texto, que es lo unico que asegura contraste
              // contra obsidian sin medir nada.
              <mark key={i} className="rounded-[2px] bg-flare px-0.5 text-obsidian">
                {parte.text}
              </mark>
            ) : (
              <span key={i}>{parte.text}</span>
            ),
          )
        )}
      </p>

      {/*
        La bandera es un boton real y no un `div` con `onClick`: con el raton funciona
        igual, pero asi el tabulador la alcanza y se marca con Enter. Se deja oculta
        (`opacity-0`) hasta que la fila tiene el foco o el puntero encima, porque 500
        banderas visibles serian ruido; `focus-visible` la saca tambien al tabular, que
        es el caso en el que un elemento invisible de verdad seria un fallo.
      */}
      <button
        type="button"
        onClick={() => onToggle(block.id)}
        aria-pressed={marcado}
        aria-label={marcado ? `Quitar el marcador de la frase de las ${clock(block.startMs)}` : `Marcar la frase de las ${clock(block.startMs)}`}
        title={marcado ? "Quitar marcador (Ctrl+B)" : "Marcar como punto clave (Ctrl+B)"}
        className={`absolute -left-2 top-0.5 flex h-6 w-6 items-center justify-center rounded-full
                    border transition-all duration-200
                    focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2
                    focus-visible:outline-neon ${
                      marcado
                        ? "border-flare bg-flare/20 opacity-100"
                        : "border-neon/20 bg-panel/80 opacity-0 group-hover:opacity-100 hover:border-neon/60"
                    }`}
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current" aria-hidden="true">
          <path d="M4 1.5h8l-1.2 4 1.2 4H8.6V14.5H7.4V9.5H4l1.2-4z" />
        </svg>
      </button>
    </div>
  );
});

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
