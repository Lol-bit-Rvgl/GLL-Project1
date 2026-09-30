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

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
