/**
 * Ventana de renderizado del historial.
 *
 * # El problema
 *
 * El historial crece sin limite: una reunion de dos horas son miles de bloques, y
 * cada uno es un `<div>` con su texto. El navegador construye miles de nodos, calcula
 * estilo y calcula disposicion para todos en cada repintado. A partir de unos cientos de
 * bloques eso se nota, y en el webview de Tauri, que comparte proceso con el worker de
 * inferencia, se nota el doble: el hilo principal se atasca y la transcripcion misma se
 * ralentiza.
 *
 * # Por que una ventana con espaciadores y NO agrupar bloques viejos
 *
 * Lo otro que se puede hacer es colapsar el principio del historial en un resumen ("342
 * frases anteriores"). Es mas barato todavia, pero **cambia la altura del contenedor**, y
 * con ella la posicion del scroll. Un bloque que se cierra mientras el usuario esta
 * leyendo la mitad del historial le haria saltar de golpe a otra frase, y el autoscroll
 * dejaria de significar nada. Aqui la altura total se conserva siempre; lo unico que
 * cambia es cuantos `<div>` existen de verdad.
 *
 * El alto por bloque es una ESTIMACION, no una medida. Es lo que hace este esquema
 * trivial: no hay que ir midiendo cada bloque en un `ResizeObserver` ni mantener un
 * indice de alturas, con el coste de memoria y de CPU que eso cuesta, a cambio de que la
 * barra de scroll tenga una precision de un bloque. La consecuencia honesta es que el
 * pulgar puede no caer exactamente sobre la ultima frase; el contenido que se ve, si.
 *
 * # Por que la funcion es pura
 *
 * Recibe numeros y devuelve numeros. No lee el DOM ni escribe estado, asi que se
 * ejercita entera con `node` sin montar React, que es justo lo que este repo no puede
 * hacer con un componente. Los limites de la ventana (cuanto se pinta, cuanto se deja
 * de margen) son numeros exportados y no constantes escondidas en el JSX.
 */

/**
 * A partir de este numero de bloques se empieza a ventilar.
 *
 * 150 sale de medir: por debajo, el historial entero cabe en el DOM sin que se note, y
 * ventilar solo costaria scrolls de mas. Es un umbral de RENDIDO, no de capacidad: con
 * 150 bloques el canal esta llenando la pantalla hace rato.
 */
export const LIMITE_RENDER = 150;

/**
 * Bloques que se pintan de mas por encima y por debajo de la ventana visible.
 *
 * Sin margen, al llegar al borde de la ventana se veria un hueco vacio hasta que el
 * siguiente repintado rellenara. El margen compra la holgura para que el scroll del
 * usuario y el programatico no alcancen nunca el borde.
 */
export const MARGEN_BLOQUES = 8;

/**
 * Alto estimado de un bloque, en px.
 *
 * Un bloque son dos lineas como mucho (timestamp en linea con la primera) a
 * `leading-7` (28 px) mas el margen inferior de 12 px. Se redondea a 56 porque por
 * encima es preferible sobrar espacio de scroll antes que quedarse corto, que es lo
 * unico que haria aparecer un hueco abajo.
 */
export const ALTO_BLOQUE_ESTIMADO = 56;

/** Que se pinta y cuanto hueco se deja a cada lado. */
export type Ventana = {
  /** Primer indice pintado, incluido. */
  from: number;
  /** Ultimo indice pintado, excluido. */
  to: number;
  /** Hueco que ocupa lo que queda por encima de la ventana. */
  arribaPx: number;
  /** Hueco que ocupa lo que queda por debajo de la ventana. */
  abajoPx: number;
  /** `true` si hay bloques sin pintar: el texto va a ser largo. */
  ventilada: boolean;
};

/** Ventana de todo el historial: no hay huecos y no se ha movido nada. */
export function ventanaCompleta(total: number): Ventana {
  return { from: 0, to: total, arribaPx: 0, abajoPx: 0, ventilada: false };
}

/**
 * Decide que bloques pintar.
 *
 * @param total      Cuantos bloques hay en el historial.
 * @param scrollTop  Cuanto se ha desplazado el canal, en px.
 * @param viewportPx  Alto visible del canal, en px.
 * @param altoPx     Alto por bloque. Se pasa para poder recalibrar con una medida real.
 * @param pegadoAlFinal  `true` si el autoscroll sigue pegado abajo.
 */
export function planVentana(
  total: number,
  scrollTop: number,
  viewportPx: number,
  altoPx: number = ALTO_BLOQUE_ESTIMADO,
  margen: number = MARGEN_BLOQUES,
): Ventana {
  if (total <= 0) return ventanaCompleta(0);
  // Por debajo del limite se pinta todo. No es pereza: con el historial entero en el DOM
  // el scroll es exacto y el usuario puede buscar en la pagina con el buscador del
  // navegador, y ventilar a los 140 bloques solo produciria parpadeos sin ganancia.
  if (total <= LIMITE_RENDER) return ventanaCompleta(total);

  const alto = Math.max(1, altoPx);
  const visibles = Math.ceil(viewportPx / alto) + margen * 2;
  // El tope de bloques pintados de golpe. Sin tope, una ventana de 4000 px de alto
  // (un monitor enorme, o un zoom del 400 %) pediria 90 bloques de una vez; con el tope
  // se sube el scroll y ya se pintan los siguientes.
  const tope = Math.max(24, Math.min(visibles, 120));

  // Cuando el autoscroll esta pegado abajo, la region visible es el FINAL, no la que
  // resulta del `scrollTop` anterior: los bloques acaban de llegar y el `scrollTop` aun
  // es el de antes de que los insertaran. Sin esta rama, el bloque nuevo caeria fuera
  // de la ventana y se veria un hueco al final hasta el siguiente scroll.
  const desdeElFinal = scrollTop + viewportPx >= total * alto - margen * alto;
  const fin = desdeElFinal ? total : 0;

  let from: number;
  if (fin === total) {
    from = total - tope;
  } else {
    from = Math.floor(Math.max(0, scrollTop) / alto) - margen;
  }
  from = Math.max(0, Math.min(from, total - tope));

  const to = Math.min(total, from + tope);

  return {
    from,
    to,
    arribaPx: from * alto,
    abajoPx: (total - to) * alto,
    ventilada: true,
  };
}

/** `true` si dos ventanas pintan lo mismo, para no re-renderizar en cada pixel. */
export function mismaVentana(a: Ventana, b: Ventana): boolean {
  return a.from === b.from && a.to === b.to;
}
