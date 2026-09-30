/**
 * Atajos de teclado globales de la pagina.
 *
 * # Por que viven en un hook y no en cada componente
 *
 * `Ctrl+B` marca un bloque y `Ctrl+F` abre el buscador. Los dos necesitan el estado del
 * hook `useTranscript`, que vive en `page.tsx`, y los dos tendrian que funcionar con el
 * raton en cualquier parte de la ventana, incluido el campo de busqueda abierto. Si cada
 * uno se escuchara en el componente que pinta, el atajo dejaria de funcionar en cuanto
 * el foco estuviera en otro sitio, que es el caso normal.
 *
 * # Por que se ignoran los eventos del propio navegador
 *
 * `Ctrl+B` y `Ctrl+F` ya estan asignados: en Firefox, `Ctrl+B` pone en negrita lo
 * seleccionado y `Ctrl+F` abre el buscador del navegador, que con este historial
 * encuentra las mismas palabras pero sin el resaltado ni el recuento. Por eso se
 * cancelan a proposito en toda la app, y no solo dentro del canal de texto. Sin
 * `preventDefault`, el atajo abriria DOS buscadores y el del navegador se llevaria el
 * foco: el campo propio quedaria a medias, sin cursor.
 *
 * Se cede el paso cuando el foco esta en un campo de texto, salvo que este dentro del
 * buscador propio: ahi `Ctrl+F` tiene que funcionar, porque el usuario esta buscando y
 * volver a abrirlo sobre el propio campo no haria nada util.
 *
 * # Por que se comprueban `ctrlKey` y `metaKey`
 *
 * En un Mac el atajo equivalente lleva `metaKey` (la tecla Cmd). Aceptar las dos hace que
 * el codigo sea el mismo en los dos sistemas, y `AGENTS.md` ya obliga a no decidir por
 * el sistema operativo.
 *
 * # Por que el atajo de marcar mira el ULTIMO bloque
 *
 * "Marca lo que acabo de decir" es la accion de tomar apuntes. No hay ninguna otra
 * interpretacion razonable de `Ctrl+B` mientras se transcribe: marcar un bloque al azar
 * seria una accion que el usuario tendria que buscar primero, y para eso esta el boton de
 * la bandera, que si actua sobre el bloque concreto.
 */
import { useEffect } from "react";

export type Shortcuts = {
  /** Marca o desmarca el bloque mas reciente. */
  onToggleBookmark: () => void;
  /** Abre el buscador. */
  onOpenSearch: () => void;
  /** Cierra el buscador. */
  onCloseSearch: () => void;
  /** `true` si el buscador esta abierto. */
  searchOpen: boolean;
  /** `true` si hay bloques que marcar. */
  canBookmark: boolean;
};

/** Campos donde `Ctrl+B`/`Ctrl+F` pertenecen al navegador o al propio campo. */
function esCampoDeTexto(destino: EventTarget | null): boolean {
  if (!(destino instanceof HTMLElement)) return false;
  if (destino.isContentEditable) return true;
  const tag = destino.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  // Un `checkbox` o un `range` es un `INPUT` pero no escribe texto, y en esos el
  // atajo no debe tratarse como edicion.
  const tipo = (destino as HTMLInputElement).type;
  return !["checkbox", "radio", "range", "button", "submit", "file"].includes(tipo);
}

export function useShortcuts({
  onToggleBookmark,
  onOpenSearch,
  onCloseSearch,
  searchOpen,
  canBookmark,
}: Shortcuts) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // `altKey` se deja pasar: es el modificador de los menus de Windows, y capturar sus
      // atajos dejaria la app sin barra de menus en el modo mini, que no tiene marco.
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.altKey) return;
      // `shift` convierte a `Ctrl+Shift+B`/`Ctrl+Shift+F`, que no son estos atajos. Sin
      // esta comprobacion, marcar con mayus pulsada seria una accion distinta y
      // silenciosa.
      if (event.shiftKey) return;

      const enCampo = esCampoDeTexto(event.target);

      if (event.key === "b" || event.key === "B") {
        // En un campo de texto, `Ctrl+B` es negrita del navegador y no se toca. Marcar
        // un bloque mientras se edita algo mas no es lo que el usuario quiere.
        if (enCampo) return;
        if (!canBookmark) return;
        event.preventDefault();
        onToggleBookmark();
        return;
      }

      if (event.key === "f" || event.key === "F") {
        // Aqui si se captura dentro de un campo, y en especial dentro del buscador
        // propio. Pero es un conmutador: con el buscador ya abierto lo CIERRA en vez
        // de reabrirlo, que sobre el propio campo solo haria parpadear el foco.
        event.preventDefault();
        if (searchOpen) {
          onCloseSearch();
        } else {
          onOpenSearch();
        }
        return;
      }

      // Escape cierra el buscador desde cualquier parte, incluso con el foco fuera del
      // canal. Sin esto, el unico camino para cerrarlo es el boton, y el usuario que ha
      // escrito en el campo y luego ha pulsado Tab no lo encuentra.
      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        onCloseSearch();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canBookmark, onCloseSearch, onOpenSearch, onToggleBookmark, searchOpen]);
}
