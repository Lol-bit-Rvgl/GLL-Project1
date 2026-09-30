"use client";

/**
 * Zona donde se sueltan los ficheros de musica.
 *
 * # Por que escucha a `window` y no a un `<div>`
 *
 * El texto de la aplicacion dice "suelta ficheros en la ventana". Con los eventos
 * puestos en un `<div>` que envuelve la barra inferior, eso solo es cierto en los
 * ultimos 60 px de la pantalla: se arrastra el fichero hasta arriba y no se enciende
 * nada. Puestos en `window`, el arrastre se ve en toda la superficie, que es lo que
 * promises la interfaz.
 *
 * El overlay se monta con `createPortal` sobre `document.body` por la misma razon: un
 * `position: fixed` dentro de un subarbol sigue siendo fijo respecto a la ventana, pero
 * cualquier ancestro con `transform`, `filter` o `backdrop-filter` lo convierte en
 * relativo a ese ancestro. El reproductor tiene `backdrop-blur` en sitios, asi que el
 * overlay se porta a `body` y se libra del problema entero.
 *
 * # Por que `dragenter`/`dragleave` y no un contador de estado
 *
 * El clasico fallo de una drop zone es parpadear en los bordes: `dragleave` tambien
 * dispara cuando el puntero pasa por encima de un hijo, asi que un contador ingenuo
 * alterna entradas y salidas mientras se mueve el fichero. El contador de aqui es un
 * `ref`, no un estado: el estado solo se pone a `true` cuando la profundidad pasa de
 * cero, y a `false` cuando vuelve a cero. Un render por cada pixel que cruza un hijo
 * del overlay, no.
 *
 * # `dragover` tiene que decir que si
 *
 * Sin `preventDefault()` en `dragover`, el navegador cancela el evento y el `drop` no
 * ocurre nunca. Es el requisito mas olvidado de las drop zones.
 *
 * # Hay que mirar los tipos
 *
 * `DataTransfer.types` es la unica forma de saber si lo arrastrado son ficheros o un
 * texto, y por dentro: el texto se puede soltar en cualquier parte de la ventana
 * (una URL pegada es util) y solo los ficheros activan la zona.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { isAudioFile } from "@/lib/player/types";

export type DropZoneProps = {
  /** Avisa de los ficheros de audio aceptados. */
  onFiles: (files: readonly File[]) => void;
  children?: React.ReactNode;
};

export function DropZone({ onFiles, children }: DropZoneProps) {
  // La profundidad viva del arrastre. Es un `ref` y no un estado porque cambiar en cada
  // `dragenter` provocaria un render por cada pixel que cruza un hijo del overlay.
  const depth = useRef(0);
  const [hovering, setHovering] = useState(false);
  // El manejador de `drop` se registra una vez, en el efecto, y no se vuelve a
  // registrar cuando cambia el callback. Sin este `ref` habria que re-suscribir los
  // cuatro escuchas de `window` en cada render del dock, que son cuatro por segundo.
  //
  // El `ref` se actualiza **en un efecto**, nunca durante el render: escribir un
  // `ref.current` en el cuerpo del render es exactamente lo que prohibe la regla
  // `react-hooks/refs` de React Compiler, porque es una escritura que el render puede
  // repetir o descartar. En un efecto si es legitimo: el compromiso esta garantizado.
  const files = useRef(onFiles);
  useEffect(() => {
    files.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean =>
      event.dataTransfer != null &&
      Array.prototype.includes.call(event.dataTransfer.types, "Files");

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setHovering(true);
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      // Sin esto el `drop` no llega a dispararse nunca.
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    };

    const onDragLeave = (event: DragEvent) => {
      if (event.dataTransfer == null) return;
      depth.current -= 1;
      if (depth.current <= 0) {
        depth.current = 0;
        setHovering(false);
      }
    };

    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setHovering(false);
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      // Se filtran aqui y no en quien recibe: un `.txt` soltado en la ventana no
      // deberia llegar ni a la cola ni a un error.
      const audio = dropped.filter((file) => isAudioFile(file.name));
      if (audio.length > 0) files.current(audio);
    };

    // El `drop` pone la profundidad a cero, asi que un `dragleave` que llegue despues
    // al salir de la ventana no puede dejar el contador en negativo.
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // El overlay solo se monta con `hovering`, y `hovering` solo puede pasar a `true`
  // desde un evento del navegador. Por eso `document` no existe todavia durante el
  // prerender de `next build` y el primer render del cliente coincide con el del
  // servidor: no hace falta un estado de "montado" ni un IIFE asincrono.
  return (
    <>
      {/* `contents` en vez de un div: sin listeners aqui dentro, la caja no aporta
          nada y solo estorbaria a los posicionados del dock. */}
      <div className="contents">{children}</div>
      {hovering &&
        typeof document !== "undefined" &&
        createPortal(<DropOverlay />, document.body)}
    </>
  );
}
function DropOverlay() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-obsidian/85 backdrop-blur-sm"
      aria-hidden="true"
    >
      <div
        className="animate-[fade-in_200ms_ease-out] flex flex-col items-center gap-3 rounded-2xl
                   border-2 border-dashed border-neon/70 bg-panel/95 px-14 py-10
                   shadow-[0_0_60px_rgba(255,107,0,0.25)]"
      >
        <svg viewBox="0 0 24 24" className="h-9 w-9 fill-flare" aria-hidden="true">
          <path d="M12 3v10.6l3.3-3.3 1.4 1.4L11 17.4 5.3 11.7l1.4-1.4 3.3 3.3V3zM4 19h16v2H4z" />
        </svg>
        <p className="text-sm font-medium text-snow">Suelta para anadir a la cola</p>
        <p className="font-mono text-[10px] text-slate-ink">mp3 · wav · ogg · flac · m4a</p>
      </div>
    </div>
  );
}
