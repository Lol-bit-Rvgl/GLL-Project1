/**
 * Lectura de etiquetas de audio, sin dependencias.
 *
 * # Por que a mano y no con una libreria
 *
 * `music-metadata` arrastra sus propias dependencias y este equipo tiene ~1 GB de RAM y
 * builds de doce minutos. Ademas, aqui solo hacen falta cuatro campos: titulo, artista,
 * album y portada. Se implementan los tres contenedores que los cubren de verdad:
 *
 * - **ID3v2** (2.2, 2.3 y 2.4) para MP3 y para el WAV/MP4 que traiga tags sueltos.
 * - **FLAC**: bloques de metadatos STREAMINFO/VORBIS_COMMENT/PICTURE.
 * - **MP4/M4A**: la cadena de atomos `moov > udta > meta > ilst` de QuickTime.
 * - **Ogg**: se buscan los marcadores `\x03vorbis` y `\x03OpusTags` y se lee el
 *   comentario de Vorbis, que es el mismo formato en los dos casos.
 *
 * Lo que no se busca son las paginas Ogg segmentadas en general: solo se lee el
 * comentario de la primera, que es donde esta. La duracion de un Ogg sale de la
 * pagina Opus, y esa se deja: la pone el navegador al cargar, igual que en el resto
 * de formatos, y aqui no hay nada que inventar.
 *
 * # Todo es defensivo
 *
 * Un fichero truncado, un ID3 con tamano mentiroso o una portada con bytes de mas no
 * pueden romper la app: cada lector va envuelto, y cualquier excepcion se traduce en
 * "sin metadatos". Un reproductor que se cae al abrir una cancion es inservible; uno
 * que muestra `cancion.mp3` sin caratula es perfectamente usable.
 */

/** Lo que se puede sacar de un fichero de audio. */
export type Tags = {
  title: string | null;
  artist: string | null;
  album: string | null;
  /** MIME de la imagen, si habia portada. */
  artworkMime: string | null;
  /** Bytes de la portada, si habia. */
  artwork: Uint8Array | null;
};

const EMPTY: Tags = { title: null, artist: null, album: null, artworkMime: null, artwork: null };

/** Cuanto se lee del principio del fichero. Las caratulas suelen caber aqui. */
const HEAD_BYTES = 3 * 1024 * 1024;

/** Cuanto se busca un marcador de Ogg antes de rendirse. */
const OGG_SCAN_BYTES = 128 * 1024;

/**
 * Lee las etiquetas de un fichero.
 *
 * `head` es el principio del fichero, no el fichero entero: leer 60 MB para sacar
 * 200 KB de texto habria creado un array de bytes gigante en un equipo que no tiene
 * memoria para eso.
 */
export async function readTags(file: File): Promise<Tags> {
  try {
    const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    const sniffed = sniff(head);
    if (sniffed === "id3") return readId3(head) ?? EMPTY;
    if (sniffed === "flac") return readFlac(head);
    if (sniffed === "mp4") return readMp4(head);
    if (sniffed === "ogg") return readOgg(head) ?? EMPTY;
    // WAV sin ID3: solo se puede sacar la duracion del bloque de cabecera.
    return EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Titulo de reserva cuando el fichero no trae ninguno. */
export function titleFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  // `03 - Bohemian Rhapsody.mp3` se muestra como `Bohemian Rhapsody`: el numero de
  // pista es informacion del fichero, no del titulo.
  return stem.replace(/^\s*\d{1,3}\s*[-._)]\s*/, "").trim() || name;
}

type Sniff = "id3" | "flac" | "mp4" | "ogg" | "wav" | "unknown";

function sniff(head: Uint8Array): Sniff {
  if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return "id3";
  if (head.length >= 4 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
    return "flac";
  }
  if (head.length >= 4 && head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) {
    return "ogg";
  }
  if (head.length >= 4 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
    return "wav";
  }
  if (head.length >= 8) {
    // Tamano de la caja, luego `ftyp`.
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return "mp4";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// ID3v2
// ---------------------------------------------------------------------------

function readId3(head: Uint8Array): Tags | null {
  if (head.length < 10) return null;
  const version = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  // La cabecera de 10 bytes mas el tamano declarado. Si el fichero esta truncado se
  // limita a lo que hay: leer de mas daria basura con forma de texto.
  const end = Math.min(head.length, 10 + size);
  if (end <= 10) return null;
  // El pie extendido, si lo hay, va despues de los frames y no es un frame.
  const hasFooter = (flags & 0x10) !== 0;
  const stop = hasFooter ? end - 10 : end;
  // v2.2 usa identificadores de 3 bytes y no tiene byte de flags por frame.
  const idLen = version <= 2 ? 3 : 4;
  const frameHeader = version <= 2 ? 6 : 10;

  const tags: Tags = { ...EMPTY };
  let at = 10;
  while (at + frameHeader <= stop) {
    const id = ascii(head, at, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // relleno: se acabaron los frames
    const frameSize = version <= 2 ? be24(head, at + 3) : readFrameSize(head, at + 4, version);
    const dataStart = at + frameHeader;
    if (frameSize <= 0 || dataStart + frameSize > stop) break;
    const data = head.subarray(dataStart, dataStart + frameSize);

    if (id === "TIT2" || id === "TT2") tags.title = decodeTextFrame(data);
    else if (id === "TPE1" || id === "TP1") tags.artist = decodeTextFrame(data);
    else if (id === "TALB" || id === "TAL") tags.album = decodeTextFrame(data);
    else if ((id === "APIC" || id === "PIC") && tags.artwork === null) {
      const picture = decodePictureFrame(data, id === "PIC");
      if (picture !== null) {
        tags.artworkMime = picture.mime;
        tags.artwork = picture.bytes;
      }
    }
    at = dataStart + frameSize;
  }
  return tags;
}

/** v2.4 usa enteros syncsafe; v2.3 usa los 4 bytes normales. */
function readFrameSize(head: Uint8Array, at: number, version: number): number {
  return version >= 4 ? syncsafe(head, at) : be32(head, at);
}

function syncsafe(head: Uint8Array, at: number): number {
  return (
    ((head[at] & 0x7f) << 21) |
    ((head[at + 1] & 0x7f) << 14) |
    ((head[at + 2] & 0x7f) << 7) |
    (head[at + 3] & 0x7f)
  );
}

function be32(head: Uint8Array, at: number): number {
  return (
    ((head[at] << 24) | (head[at + 1] << 16) | (head[at + 2] << 8) | head[at + 3]) >>> 0
  );
}

function be24(head: Uint8Array, at: number): number {
  return (head[at] << 16) | (head[at + 1] << 8) | head[at + 2];
}

function ascii(head: Uint8Array, at: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i += 1) out += String.fromCharCode(head[at + i] ?? 0);
  return out;
}

/**
 * Un frame de texto empieza con un byte de codificacion.
 *
 * El 0 es ISO-8859-1, no UTF-8: hay ficheros de los 90 que lo llevan ahi y UTF-8 los
 * destrozaria. El 1 es UTF-16 con BOM, y el 2 UTF-16 sin BOM, big endian. El 3 es UTF-8.
 */
function decodeTextFrame(data: Uint8Array): string | null {
  if (data.length < 2) return null;
  const encoding = data[0];
  const body = data.subarray(1);
  let text: string;
  if (encoding === 0) {
    text = latin1(body);
  } else if (encoding === 1) {
    text = utf16(body, true);
  } else if (encoding === 2) {
    text = utf16(body, false);
  } else {
    text = new TextDecoder("utf-8").decode(body);
  }
  // Los tags sueltos traen nulls y espacios al final para cuadrar el tamano fijo.
  const clean = text.replace(/\0+/gu, "").trim();
  return clean === "" ? null : clean;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function utf16(bytes: Uint8Array, withBom: boolean): string {
  let start = 0;
  let littleEndian = false;
  if (withBom && bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      littleEndian = true;
      start = 2;
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      littleEndian = false;
      start = 2;
    }
  }
  const units: number[] = [];
  for (let i = start; i + 1 < bytes.length; i += 2) {
    units.push(littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
  }
  // `String.fromCharCode` se desborda con arrays largos; se trocea.
  let out = "";
  for (let i = 0; i < units.length; i += 4096) {
    out += String.fromCharCode(...units.slice(i, i + 4096));
  }
  return out;
}

/** `APIC` (v2.3+) y `PIC` (v2.2), que codifica el MIME en 3 caracteres. */
function decodePictureFrame(data: Uint8Array, legacy: boolean): { mime: string; bytes: Uint8Array } | null {
  if (data.length < 4) return null;
  const encoding = data[0] ?? 0;
  let mime: string;
  let descriptionAt: number;
  if (legacy) {
    mime = ascii(data, 1, 3).toUpperCase();
    // v2.2 codifica `PNG` como `PNG` y `JPG` como `JPG`; no hay barra oblicua.
    if (mime === "JPG") mime = "image/jpeg";
    else if (mime === "PNG") mime = "image/png";
    // El v2.2 no tiene byte de tipo de imagen: la descripcion viene justo detras del
    // formato de tres letras.
    descriptionAt = 4;
  } else {
    const nul = indexOf(data, 0, 1);
    if (nul < 0) return null;
    mime = latin1(data.subarray(1, nul));
    // v2.3 y v2.4: `encoding | mime\0 | tipo | descripcion`. El byte de tipo de
    // imagen se salta siempre. La version anterior lo leia como si fuera el de
    // codificacion, y de ahi salia un MIME con un `\x03` pegado y una portada a la
    // que le faltava el primer byte.
    descriptionAt = nul + 2;
  }
  // La descripcion va terminada en null, en la misma codificacion del byte 0.
  let cursor = descriptionAt;
  if (encoding === 1) {
    const found = findUtf16Null(data, cursor);
    if (found < 0) return null;
    // El terminador UTF-16 son **dos** bytes a cero. Quedarse en el indice del primero
    // hacia que la portada empezase por un `\0\0`, y el navegador rechazaba el blob por
    // no ser una imagen valida.
    cursor = found + 2;
  } else {
    const found = indexOf(data, 0, cursor);
    if (found < 0) return null;
    cursor = found + 1;
  }
  const bytes = data.subarray(cursor);
  if (bytes.length === 0) return null;
  return { mime: mime || "image/jpeg", bytes };
}

function indexOf(data: Uint8Array, value: number, from: number): number {
  for (let i = from; i < data.length; i += 1) if (data[i] === value) return i;
  return -1;
}

function findUtf16Null(data: Uint8Array, from: number): number {
  for (let i = from; i + 1 < data.length; i += 2) {
    if (data[i] === 0 && data[i + 1] === 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

function readFlac(head: Uint8Array): Tags {
  const tags: Tags = { ...EMPTY };
  let at = 4; // "fLaC"
  while (at + 4 <= head.length) {
    const isLast = (head[at] & 0x80) !== 0;
    const type = head[at] & 0x7f;
    const size = be24(head, at + 1);
    const body = head.subarray(at + 4, at + 4 + size);
    if (type === 4) {
      const comment = readVorbisComment(body);
      tags.title = comment.title;
      tags.artist = comment.artist;
      tags.album = comment.album;
    } else if (type === 6 && tags.artwork === null) {
      const picture = readFlacPicture(body);
      if (picture !== null) {
        tags.artworkMime = picture.mime;
        tags.artwork = picture.bytes;
      }
    }
    if (isLast) break;
    at += 4 + size;
  }
  return tags;
}

/** Bloque `PICTURE` de FLAC, que es el mismo layout que `APIC` pero en big endian. */
function readFlacPicture(body: Uint8Array): { mime: string; bytes: Uint8Array } | null {
  if (body.length < 8) return null;
  const mimeLen = be32(body, 4);
  if (mimeLen <= 0 || 8 + mimeLen + 4 > body.length) return null;
  const mime = ascii(body, 8, mimeLen);
  let at = 8 + mimeLen;
  const descLen = be32(body, at);
  at += 4;
  if (at + descLen > body.length) return null;
  at += descLen;
  // ancho, alto, profundidad, colores: 16 bytes que no interesan.
  at += 16;
  if (at + 4 > body.length) return null;
  const dataLen = be32(body, at);
  at += 4;
  if (dataLen <= 0 || at + dataLen > body.length) return null;
  return { mime: mime || "image/jpeg", bytes: body.subarray(at, at + dataLen) };
}

// ---------------------------------------------------------------------------
// Vorbis comments (compartidos por FLAC y Ogg)
// ---------------------------------------------------------------------------

function readVorbisComment(body: Uint8Array): { title: string | null; artist: string | null; album: string | null } {
  const out: { title: string | null; artist: string | null; album: string | null } = {
    title: null,
    artist: null,
    album: null,
  };
  if (body.length < 8) return out;
  let at = 0;
  const vendorLen = le32(body, at);
  at += 4;
  at += vendorLen;
  if (at + 4 > body.length) return out;
  const count = le32(body, at);
  at += 4;
  // Se acota `count` a lo que cabe de verdad: un campo con numero enorme haria el
  // bucle leer fuera del buffer (que en JS da `undefined` y valores `NaN` silenciosos).
  const limit = Math.min(count, Math.floor((body.length - at) / 4));
  for (let i = 0; i < limit; i += 1) {
    const len = le32(body, at);
    at += 4;
    if (len < 0 || at + len > body.length) break;
    const entry = new TextDecoder("utf-8").decode(body.subarray(at, at + len));
    at += len;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = entry.slice(eq + 1).trim();
    if (value === "") continue;
    if (key === "TITLE" && out.title === null) out.title = value;
    else if (key === "ARTIST" && out.artist === null) out.artist = value;
    else if (key === "ALBUM" && out.album === null) out.album = value;
    // Los tags duplicados (varios ARTIST por colaboradores) se ignoran a proposito:
    // la UI muestra uno, y WHICH=1 suele ser el que el usuario quiere.
  }
  return out;
}

function le32(data: Uint8Array, at: number): number {
  return (
    ((data[at + 3] << 24) | (data[at + 2] << 16) | (data[at + 1] << 8) | data[at]) >>> 0
  );
}

/**
 * Ogg Vorbis y Opus.
 *
 * Las etiquetas estan dentro de paginas Ogg segmentadas, y recorrer la estructura de
 * paginas con segmentos de tamano variable es mas codigo del que aporta: estos
 * ficheros son raros como formato de entrada y el titulo cae al nombre del archivo.
 * Se mira unicamente si el comentario aparece en el tramo leido, que es el caso
 * normal de un archivo con tags puestos por un ripeador.
 */
function readOgg(head: Uint8Array): Tags | null {
  const end = Math.min(head.length, OGG_SCAN_BYTES);
  // `\x03vorbis` abre el comentario; `\x03OpusTags` el de Opus.
  for (const marker of ["\x03vorbis", "\x03OpusTags"]) {
    // Se busca la **cadena entera**, no su primer byte. El 0x03 es un tipo de paquete
    // y aparece a cada poco dentro de audio binario, asi que buscarlo solo encontraba
    // basura y la devolvia como si fueran etiquetas. Ademas se respeta el limite de
    // busqueda: fuera de `end` no hay pagina de cabecera, y leer mas alla meteria
    // samples de audio en el parser.
    const at = indexOfSequence(head, marker, 0, end);
    if (at < 0) continue;
    const comment = readVorbisComment(head.subarray(at + marker.length));
    return { ...EMPTY, ...comment };
  }
  return null;
}

/** Primera posicion de `needle` completa dentro de `[from, to)`. */
function indexOfSequence(
  haystack: Uint8Array,
  needle: string,
  from: number,
  to: number,
): number {
  const limit = Math.min(to, haystack.length) - needle.length;
  for (let at = Math.max(from, 0); at <= limit; at += 1) {
    let hit = true;
    for (let i = 0; i < needle.length; i += 1) {
      if (haystack[at + i] !== needle.charCodeAt(i)) {
        hit = false;
        break;
      }
    }
    if (hit) return at;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// MP4 / M4A
// ---------------------------------------------------------------------------

/**
 * QuickTime: `moov > udta > meta > ilst` con una hoja `\u00a9nam`, `\u00a9ART`, `\u00a9alb` y `covr`.
 *
 * `meta` lleva 4 bytes de version y banderas antes de sus hijos, que es el error
 * clasico al recorrer estos atomos: sin ese salto, `ilst` nunca aparece y el fichero
 * parece no tener tags.
 */
function readMp4(head: Uint8Array): Tags {
  const tags: Tags = { ...EMPTY };
  for (const moov of findBoxes(head, 0, head.length, "moov")) {
    for (const udta of findBoxes(head, moov.bodyStart, moov.bodyEnd, "udta")) {
      for (const meta of findBoxes(head, udta.bodyStart, udta.bodyEnd, "meta")) {
        // `meta` lleva 4 bytes de version y banderas antes de sus hijos. Sin este
        // salto, `ilst` no aparece y el fichero parece no tener etiquetas.
        for (const ilst of findBoxes(head, meta.bodyStart + 4, meta.bodyEnd, "ilst")) {
          readIlst(head, ilst.bodyStart, ilst.bodyEnd, tags);
        }
      }
    }
  }
  return tags;
}

type Box = { start: number; bodyStart: number; bodyEnd: number };

function findBoxes(
  head: Uint8Array,
  from: number,
  to: number,
  name: string,
): Box[] {
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size = be32(head, at);
    const label = ascii(head, at + 4, 4);
    if (size < 8) break; // tamano invalido: caja de 0 significa "hasta el final"
    const end = Math.min(at + size, to);
    if (label === name) found.push({ start: at, bodyStart: at + 8, bodyEnd: end });
    at += size;
  }
  return found;
}

function readIlst(head: Uint8Array, from: number, to: number, tags: Tags): void {
  let at = from;
  while (at + 8 <= to) {
    const size = be32(head, at);
    const name = ascii(head, at + 4, 4);
    if (size < 8) break;
    const end = Math.min(at + size, to);
    // Cada hoja tiene dentro un `data` con 4 bytes de tipo, 4 de locale y la carga.
    for (const data of findBoxes(head, at + 8, end, "data")) {
      if (data.bodyEnd - data.bodyStart < 8) continue;
      const payload = head.subarray(data.bodyStart + 8, data.bodyEnd);
      const value = new TextDecoder("utf-8").decode(payload).replace(/\0+/gu, "").trim();
      if (name === "\u00a9nam" && tags.title === null && value !== "") tags.title = value;
      else if (name === "\u00a9ART" && tags.artist === null && value !== "") tags.artist = value;
      else if (name === "\u00a9alb" && tags.album === null && value !== "") tags.album = value;
      else if (name === "covr" && tags.artwork === null && payload.length > 0) {
        tags.artworkMime = payload[0] === 0x89 ? "image/png" : "image/jpeg";
        tags.artwork = payload;
      }
    }
    at += size;
  }
}
