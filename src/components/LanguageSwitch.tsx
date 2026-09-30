"use client";

/**
 * Selector de idioma en tres pasos: ES, EN y deteccion automatica.
 *
 * # Por que tres botones y no un desplegable
 *
 * Son exactamente tres valores y ninguno es largo: caben como `ES | EN | AUTO` en unos
 * 120 px. Un `<select>` con tres opciones de una palabra cada una solo anade el clic
 * extra de abrirlo, y en un selector nativo el valor seleccionado se ve recortado en
 * cuanto la barra se estrecha.
 *
 * Se marca con `aria-checked` y `role="radio"` porque el grupo se lee como una sola
 * pregunta -en que idioma se transcribe-, y asi un lector de pantalla anuncia la
 * eleccion y la cantidad de opciones.
 *
 * # Auto es el estado por defecto y el mas probable
 *
 * Whisper detecta el idioma solo, y forced detectarlo suele acertar. Por eso `auto` va
 * el ultimo: es el estado de partida, y los dos botones de forzar son la excepcion a la
 * que se llega a proposito. Ponerlo el primero haria que la app pidiera una decision
 * antes de saber si hace falta.
 */

import type { Language } from "@/lib/types";

export type LanguageSwitchProps = {
  value: Language;
  disabled?: boolean;
  onChange: (language: Language) => void;
};

const OPCIONES: { id: Language; label: string; title: string }[] = [
  { id: "es", label: "ES", title: "Forzar espanol" },
  { id: "en", label: "EN", title: "Forzar ingles" },
  { id: "auto", label: "AUTO", title: "Detectar el idioma automaticamente" },
];

export function LanguageSwitch({ value, disabled = false, onChange }: LanguageSwitchProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Idioma de la transcripcion"
      className="flex items-center gap-0.5 rounded-full border border-neon/15 bg-raised p-0.5"
    >
      {OPCIONES.map((opcion) => {
        const activo = value === opcion.id;
        return (
          <button
            key={opcion.id}
            type="button"
            role="radio"
            aria-checked={activo}
            title={opcion.title}
            disabled={disabled}
            onClick={() => onChange(opcion.id)}
            className={`rounded-full px-2 py-1 font-mono text-[10px] tracking-wide
                        transition-colors duration-200
                        disabled:cursor-not-allowed disabled:opacity-50 ${
                          activo ? "bg-neon/20 text-flare" : "text-slate-ink hover:text-snow"
                        }`}
          >
            {opcion.label}
          </button>
        );
      })}
    </div>
  );
}
