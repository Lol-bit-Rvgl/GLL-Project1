"use client";

import { DockedPlayer } from "@/components/player/DockedPlayer";
import type { AudioSource, Language } from "@/lib/types";

export type AudioLabProps = {
  source: AudioSource;
  capturing: boolean;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  busy: boolean;
};

export function AudioLab(props: AudioLabProps) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-neon/12 bg-panel/40 px-6 py-3 backdrop-blur">
        <h2 className="text-sm font-semibold text-snow">Laboratorio de Audio</h2>
        <p className="text-xs text-slate-ink">
          Reproductor, carga de archivos, pruebas de micrófono/loopback y configuración.
        </p>
      </div>
      <div className="flex flex-1 flex-col">
        <DockedPlayer
          source={props.source}
          capturing={props.capturing}
          language={props.language}
          onLanguageChange={props.onLanguageChange}
          busy={props.busy}
        />
      </div>
    </div>
  );
}
