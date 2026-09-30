"use client";

/**
 * Vumetro de entrada.
 *
 * Muestra dos cosas: la barra de nivel instantanea y un histograma corto de los
 * ultimos valores. El histograma es lo que de verdad sirve para diagnosticar: una
 * barra que se mueve rapido no deja ver si el audio entra de continuo o a trozos.
 *
 * El componente se suscribe solo al nivel, asi que sus 7 re-renderizados por segundo
 * no tocan el historial de transcripcion, que es la parte cara del arbol.
 */

import { memo } from "react";

import { useAudioLevel } from "@/lib/useAudioLevel";

export type VuMeterProps = {
  /** `true` mientras hay captura: si no, el medidor se apaga. */
  active: boolean;
  /** Piso de ruido en dBFS que reporta el worker. */
  noiseFloorDb: number;
};

function VuMeterImpl({ active, noiseFloorDb }: VuMeterProps) {
  const level = useAudioLevel(active);

  return (
    <div className="flex items-center gap-3">
      <div className="flex h-6 flex-1 items-end gap-px" aria-hidden="true">
        {level.history.length === 0
          ? Array.from({ length: 40 }, (_, index) => (
              <Bar key={index} height={0} muted />
            ))
          : level.history.map((value, index) => (
              <Bar key={index} height={value} />
            ))}
      </div>
      <span
        className="w-12 shrink-0 text-right font-mono text-[10px] text-neutral-500 tabular-nums"
        title="Piso de ruido actual, en dBFS"
      >
        {active ? `${noiseFloorDb.toFixed(0)} dB` : "--"}
      </span>
    </div>
  );
}

function Bar({ height, muted }: { height: number; muted?: boolean }) {
  // Un suelo de 2 px para que la barra se vea aunque el silencio sea absoluto: un
  // histograma todo plano parece un componente roto.
  const pixels = Math.max(2, Math.round(Math.min(Math.max(height, 0), 1) * 24));
  // El color sigue al nivel: verde en voz, ambar al limite, rojo al clipping.
  const tone =
    height > 0.92 ? "bg-red-500" : height > 0.7 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <span
      className={`w-full rounded-sm ${muted ? "bg-neutral-800" : tone}`}
      style={{ height: `${pixels}px`, transition: "height 90ms linear" }}
    />
  );
}

export const VuMeter = memo(VuMeterImpl);
