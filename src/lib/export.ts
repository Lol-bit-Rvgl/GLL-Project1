/**
 * Exportadores de la transcripcion a TXT, Markdown y SRT.
 *
 * # Por que el texto se CONSOLIDA antes de exportar
 *
 * Whisper emite SOLO el incremento desde el parcial anterior (`WhisperEngine::increment`),
 * y la UI concatena. Eso es lo correcto para pintar en directo, pero un fichero
 * exportado necesita frases enteras: un SRT con lineas de tres palabras es ilegible.
 * Por eso `Block` agrupa los finales y `joinIncrements` recompone cada frase.
 *
 * # Elincremental no se pierde
 *
 * Un final trae el cierre de la frase, no la frase entera. `consolidate` prepende los
 * parciales que abrieron ese bloque, de modo que el TXT sale completo aunque el motor
 * solo mandara un cierre suelto. Es el mismo trabajo que hace la pantalla, hecho una
 * sola vez al exportar.
 */

import { clock, dateStamp, srtTime, wordCount } from "./format";
import type { Block } from "./transcript";

/** Formatos que el menu de descarga ofrece. */
export type ExportFormat = "txt" | "md" | "srt";

/** Metadatos que se escriben en la cabecera de Markdown. */
export type ExportMeta = {
  /** Idioma forzado, o `auto` si se dejo detectar. */
  language: string;
  /** Duracion total de la sesion, en ms. */
  durationMs: number;
  /** Instante de la exportacion, en ISO. */
  exportedAt: string;
};

/** Todo lo que hay que exportar: bloques cerrados y el texto aun abierto. */
export type ExportInput = {
  blocks: readonly Block[];
  /** Texto del segmento en curso. Solo lo usa el TXT. */
  interim: string;
  meta: ExportMeta;
};

const MIME: Record<ExportFormat, string> = {
  txt: "text/plain;charset=utf-8",
  md: "text/markdown;charset=utf-8",
  srt: "application/x-subrip;charset=utf-8",
};

const EXTENSION: Record<ExportFormat, string> = {
  txt: "txt",
  md: "md",
  srt: "srt",
};

/** Genera el texto del fichero para un formato dado. */
export function render(format: ExportFormat, input: ExportInput): string {
  const { blocks, interim, meta } = input;
  switch (format) {
    case "txt":
      // El TXT si lleva la frase abierta: el usuario espera el fichero de lo que ha
      // dicho hasta ahora, y un parrafo que se cae porque whisper aun no ha cerrado
      // la frase parece un fallo de la app.
      return renderTxt([...blocks.map((block) => block.text), interim]);
    case "md":
      return renderMarkdown(blocks, meta);
    case "srt":
      return renderSrt(blocks);
  }
}

/** Texto plano: un parrafo por frase, sin marcas de tiempo. */
export function renderTxt(paragraphs: readonly string[]): string {
  const clean = paragraphs.map((text) => text.trim()).filter((text) => text !== "");
  return clean.length === 0 ? "" : `${clean.join("\n\n")}\n`;
}

/**
 * Markdown: cabecera de marca, metadatos y un bloque por frase.
 *
 * # Por que la cabecera lleva la marca y el TXT no
 *
 * El Markdown es el unico de los tres que se abre como documento: tiene estructura, se
 * previsualiza con formato y acaba en un repositorio o en un informe. Ahi la autoria y
 * la fecha son informacion, y quitarlas al pegarlo en otro sitio deja un documento sin
 * origen.
 *
 * En TXT no se pone, y no por pereza: un `.txt` es texto plano, y un fichero que abre
 * con `#`, `*` y `---` deja de ser el texto que la persona quiere pegar en un correo o
 * en un formulario. El TXT tiene que seguir siendo exactamente lo que se ve en
 * pantalla. El SRT tampoco lleva cabecera porque su formato es cerrado: cualquier linea
 * que no sea indice, tiempos o texto hace que el reproductor de subtitulos la trate como
 * una linea de la frase.
 *
 * `Fecha` va en hora local, que es la de quien transcribe; el nombre del fichero lleva
 * su propia marca y por eso se puede seguir de un vistazo en una carpeta.
 */
export function renderMarkdown(blocks: readonly Block[], meta: ExportMeta): string {
  const total = wordCount(blocks.map((block) => block.text).join(" "));
  const lines = [
    "# Transcripcion de Sesion - LyricStream STT",
    "",
    "*Generado automaticamente por LyricStream STT (por GLL)*",
    "",
    `*Fecha: ${dateStamp(meta.exportedAt)}*`,
    "",
    "---",
    "",
    `- Duracion: ${clock(meta.durationMs)}`,
    `- Palabras: ${total}`,
    // `auto` no es un idioma concreto: decirlo evita que alguien lo lea como "ingles".
    `- Idioma: ${meta.language === "auto" ? "automatico" : meta.language}`,
    "",
  ];
  for (const block of blocks) {
    const text = block.text.trim();
    if (text === "") continue;
    lines.push(`**[${clock(block.startMs)}]** ${text}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * SRT: numeracion desde 1 y tiempos `HH:MM:SS,mmm --> HH:MM:SS,mmm`.
 *
 * Un bloque de duracion 0 se estira a 1 ms porque un `start == end` hace que algunos
 * reproductores tiren el subtitulo entero.
 */
export function renderSrt(blocks: readonly Block[]): string {
  const usable = blocks.filter((block) => block.text.trim() !== "");
  const chunks: string[] = [];
  usable.forEach((block, index) => {
    const start = Math.max(0, Math.floor(block.startMs));
    const end = Math.max(start + 1, Math.floor(block.startMs + block.durationMs));
    chunks.push(
      `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${block.text.trim()}\n`,
    );
  });
  return chunks.length === 0 ? "" : `${chunks.join("\n")}\n`;
}

/**
 * Descarga el fichero en el navegador del webview.
 *
 * Se usa un `<a download>` con un `Blob` en vez de pedir permiso de escritura a disco:
 * asi la app no necesita `fs` en `capabilities/default.json`, y el dialogo de
 * "guardar como" lo pone el propio webview. En un webview de Tauri esto abre el
 * selector de la plataforma, que es lo que espera el usuario.
 */
export function download(format: ExportFormat, contents: string, fileBaseName: string): void {
  const blob = new Blob([contents], { type: MIME[format] });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileBaseName}.${EXTENSION[format]}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Sin el revoke, el blob se queda retenido hasta que se recargue la pagina. Se
  // retrasa un tick porque Safari necesita que el click termine antes de soltarlo.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Nombre de fichero con la fecha, para no sobrescribir la sesion anterior. */
export function suggestedName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  return `lyricstream-${stamp}`;
}
