/** Formateo de tiempo, duraciones y contadores. */

/** `00:01:23.4` — marca de tiempo legible para un bloque de habla. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const tenths = Math.floor((total % 1_000) / 100);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${tenths}`;
}

/** `00:01:23,456` — el formato que exige SRT, con coma decimal. */
export function srtTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(millis).padStart(3, "0")}`;
}

/** `4.2 MB` — bytes legibles. */
export function bytes(value: number): string {
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exp;
  return `${scaled.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/** Cuenta palabras separando por espacios, como lo haría un usuario. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

/** Une fragmentos en un parrafo, sin duplicar ni partir palabras a la mitad. */
export function joinIncrements(parts: readonly string[]): string {
  let out = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (part === "") continue;
    if (out === "") {
      out = part;
    } else if (out.endsWith(" ") || out.endsWith("\n")) {
      out += part;
    } else if (part.startsWith(" ")) {
      out += part;
    } else {
      out += ` ${part}`;
    }
  }
  return out;
}

/**
 * `2026-09-30 16:23` — fecha y hora en formato corto, para la cabecera del Markdown.
 *
 * # Por que convierte y no recorta la cadena
 *
 * Quien llama tiene un `Date` o un ISO completo, y recortarlo a 16 caracteres parecia
 * suficiente hasta que salio el fallo: `toISOString()` es UTC, asi que un `slice(0, 16)`
 * ponia en el fichero la hora de UTC y no la de la persona que transcribia. Con dos horas
 * de diferencia, la fecha del documento no cuadra con la del explorador y parece un fallo.
 * Aqui se pasa por `Date`, que usa la zona local.
 *
 * `getFullYear` y no `getUTCFullYear` por lo mismo.
 */
export function dateStamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  // Una fecha invalida no es motivo para que la cabecera rompa el export: `NaN` se
  // cuela en el fichero y el usuario lo ve como un fallo de la app.
  if (Number.isNaN(date.getTime())) return "";
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
