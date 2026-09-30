/**
 * Envolvente del vumetro.
 *
 * # Por que esto vive aqui y no en CSS
 *
 * El diseno pide "subida instantanea y decaimiento suave". Con una transicion de CSS
 * eso es **imposible**: una transicion tiene una sola duracion y una sola curva, asi
 * que no se puede declarar que una propiedad suba rapido y baje lento. Y poner dos
 * `transition` de `transform` en la misma declaracion no lo arregla: la segunda
 * sustituye a la primera y solo queda una.
 *
 * La asimetria se hace entonces con una regla por muestra, que es exactamente lo que
 * hacen los vumetros analogicos: un pico cae despacio desde el valor que alcanzo, en
 * vez de desaparecer cuando el audio deja de estar.
 *
 *     mostrado[i] = max(nuevo[i], mostrado[i-1] * DECAY)
 *
 * La comparacion con `nuevo` da la subida instantanea (el valor real siempre gana, sin
 * suavizar) y la multiplicacion da la bajada lenta (cada paso solo se permite perder
 * una fraccion). Una sola pasada sobre el historial, sin estado entre llamadas: la
 * funcion es pura y se puede ejercitar entera desde `node` sin montar React.
 *
 * # Por que el decaimiento se aplica hacia atras
 *
 * El historial va del mas antiguo al mas reciente, y el envolvente se recorre en ese
 * mismo sentido: cada barra es el maximo entre su propia muestra y lo que le queda de
 * la anterior. Si se calculase al reves, la caida se acumularia en la ultima barra y
 * las de la izquierda se verian planas.
 */

/** Cuanta parte de su valor conserva una barra en cada paso hacia abajo. */
export const DECAY = 0.82;

/**
 * Altura minima de una barra, en `[0, 1]`.
 *
 * Sin suelo, una fila en silencio puro es identica a un componente roto: no se ve
 * ningun led. Un 2 % deja la fila presente y aun asi no miente sobre el nivel.
 */
export const FLOOR = 0.02;

/**
 * Aplica el envolvente de ataque y caida a un historial de niveles.
 *
 * @param history Niveles del mas antiguo al mas reciente, cada uno en `[0, 1]`.
 * @returns Un valor por muestra, en el mismo orden y con la misma longitud.
 */
export function vuEnvelope(history: readonly number[], decay: number = DECAY): number[] {
  const out: number[] = new Array(history.length);
  let held = 0;
  for (let i = 0; i < history.length; i += 1) {
    const raw = history[i];
    // Una muestra sucia se trata como silencio, y el valor se acota a `[0, 1]`.
    //
    // Lo de `NaN` no es teoria: `Math.max(NaN, x)` es `NaN`, y como `held` se
    // arrastra de una muestra a la siguiente, **una sola** muestra rota dejaba las
    // 48 barras a `NaN` para el resto de la sesion. Un `NaN` en `transform` no dibuja
    // la barra, asi que el sintoma era una fila que se vaciaba y no volvia. El hook ya
    // filtra lo que le llega del backend, pero la funcion pura se defiende sola: no
    // depende de que quien la llame se acuerde.
    //
    // Acotar tambien importa por el decaimiento: sin tope, una muestra de 5 dejaria
    // la barra "colgando" de 5 durante muchas muestras y todas se pintarian al
    // maximo, que es una saturacion fausseada en lugar de un pico real.
    const sample = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
    held = Math.max(sample, held * decay);
    out[i] = held;
  }
  return out;
}

/**
 * Escala final de una barra: envolvente acotado y con suelo.
 *
 * @param value Valor ya envuelto, en `[0, 1]`.
 */
export function vuBarScale(value: number, floor: number = FLOOR): number {
  // `NaN` cae al suelo y el resto se acota. La distincion importa: `NaN` es basura de
  // medida y lo correcto es no dibujar nada, mientras que `Infinity` es "tan alto como
  // se pueda", y mandarlo al suelo dibujaria una fila en silencio cuando en realidad
  // el nivel estaba saturado.
  if (Number.isNaN(value)) return floor;
  if (value <= floor) return floor;
  return value > 1 ? 1 : value;
}
