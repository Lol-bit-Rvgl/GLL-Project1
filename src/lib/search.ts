/**
 * Resaltado de coincidencias del buscador interno.
 *
 * # Por que esto NO es un `RegExp` con la `g`
 *
 * Un `new RegExp(texto, "gi")` se puede poner en ReDoS con cuatro caracteres:
 * `a|a|a|a` contra una frase larga hace trabajo exponencial, y el buscador corre
 * DENTRO del mismo hilo que pinta la transcripcion. Un texto de busqueda malicioso, o
 * simplemente un typo raro, congela la ventana entera. Aqui no hay motor de regex: se
 * comparan subcadenas, que es lineal y no puede explotar.
 *
 * Ademas el buscador tiene que distinguir "no hay nada" de "todo coincide". Por eso se
 * devuelve una lista de tramos y no un booleano, y quien llama decide que hacer con el
 * numero de coincidencias.
 *
 * # Normalizacion
 *
 * Se comparan minusculas sin acentos para que `transcripcion` encuentre
 * `transcripción`. Se usa `normalize("NFD")` y se quita el bloque de diacriticos
 * (`\u0300-\u036f`): `toLowerCase` no quita tildes, y el usuario escribe sin ellas.
 *
 * El indice que devuelve es sobre el texto ORIGINAL, que es lo que se pinta, asi que
 * quien resalte puede cortar por ahi sin llevar la cuenta de como se normalizo.
 */

/** Un tramo del texto original que coincide con la busqueda. */
export type Match = {
  /** Desde donde empieza la coincidencia, en indices del texto original. */
  start: number;
  /** Cuanto ocupa, en indices del texto original. */
  length: number;
};

/**
 * Tramos que coinciden con `needle` dentro de `text`.
 *
 * Devuelve `[]` si no hay nada. Los tramos salen ordenados y sin solaparse: si dos
 * coincidencias se pisan, se queda la primera. Pisar es imposible con este algoritmo
 * -avanza el indice de busqueda mas alla del tramo encontrado-, pero el filtro
 * documenta la garantia en vez de dejarla implicita.
 */
export function findMatches(text: string, needle: string): Match[] {
  if (needle === "") return [];
  const objetivo = normalize(needle);
  if (objetivo === "") return [];
  const fuente = normalize(text);
  if (objetivo.length > fuente.length) return [];

  const tramos: Match[] = [];
  let desde = 0;
  // El indice de la ultima coincidencia consumida, para no devolver dos tramos que se
  // solapen. Se avanza con `i + objetivo.length`.
  while (desde <= fuente.length - objetivo.length) {
    const i = fuente.indexOf(objetivo, desde);
    if (i === -1) break;
    tramos.push({ start: i, length: objetivo.length });
    desde = i + objetivo.length;
  }
  return tramos;
}

/** `true` si el bloque tiene al menos una coincidencia. */
export function matches(text: string, needle: string): boolean {
  if (needle === "") return false;
  const objetivo = normalize(needle);
  if (objetivo === "") return false;
  return normalize(text).includes(objetivo);
}

/** Numero total de coincidencias del historial, para la etiqueta del buscador. */
export function countMatches(blocks: { text: string }[], needle: string): number {
  if (needle === "") return 0;
  let total = 0;
  for (const block of blocks) total += findMatches(block.text, needle).length;
  return total;
}

/**
 * Trocea el texto en partes alternas (normal / coincidencia) para poder pintar el
 * resaltado con `<mark>`.
 *
 * Devuelve `null` si el texto no tiene nada que resaltar: quien llama entonces pinta el
 * texto entero y no monta ni un `mark`, que es el caso mas comun y el que no debe
 * pagar nada.
 *
 * Si el texto son solo espacios, devuelve las partes vacias para que quien llama pueda
 * conservar el hueco: es lo que mantiene la altura de una linea vacia.
 */
export function highlight(
  text: string,
  needle: string,
): { text: string; hit: boolean }[] | null {
  const tramos = findMatches(text, needle);
  if (tramos.length === 0) return null;

  const partes: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const tramo of tramos) {
    if (tramo.start > cursor) partes.push({ text: text.slice(cursor, tramo.start), hit: false });
    partes.push({ text: text.slice(tramo.start, tramo.start + tramo.length), hit: true });
    cursor = tramo.start + tramo.length;
  }
  if (cursor < text.length) partes.push({ text: text.slice(cursor), hit: false });
  return partes;
}

/**
 * Minusculas y sin diacriticos.
 *
 * `NFD` separa la `o` de su acento en dos `code points`, y el bloque `\u0300-\u036f` es
 * exactamente el de los diacriticos combinantes. Es lo que hace que `nino` encuentre
 * `niño`, y va antes de `toLowerCase` para que el caso se resuelva una sola vez.
 */
function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
}
