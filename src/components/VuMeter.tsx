"use client";

/**
 * Vumetro de entrada, como fila de leds.
 *
 * Muestra dos cosas: el nivel instantaneo y un histograma corto de los ultimos valores.
 * El histograma es lo que de verdad sirve para diagnosticar: una barra que se mueve
 * rapido no deja ver si el audio entra de continuo o a trozos.
 *
 * El componente se suscribe solo al nivel, asi que sus 7 re-renderizados por segundo
 * no tocan el historial de transcripcion, que es la parte cara del arbol.
 *
 * # Por que `scaleY` y no `height`
 *
 * Las barras tienen altura fija de celda y lo que sube y baja es una escala, no una
 * dimension. La razon esta en `globals.css` (`.vu-bar`): animar `height` pasa por
 * disposicion, y con 48 barras siete veces por segundo eso son 336 relayouts por
 * segundo en el hilo que tambien pinta la transcripcion. `transform` lo resuelve el
 * compositor. El pixel y el color van en el `style` inline, no en clases: dependen del
 * valor, y una clase distinta por barra significaria 48 cadenas nuevas por lectura.
 */

import { memo, useMemo } from "react";

import { useAudioLevel } from "@/lib/useAudioLevel";
import { vuBarScale, vuEnvelope } from "@/lib/vu";

export type VuMeterProps = {
  /** `true` mientras hay captura: si no, el medidor se apaga. */
  active: boolean;
  /** Piso de ruido en dBFS que reporta el worker. */
  noiseFloorDb: number;
};

/** Cuantos leds tiene la fila. */
const LEDS = 48;

function VuMeterImpl({ active, noiseFloorDb }: VuMeterProps) {
  const level = useAudioLevel(active);

  // El envolvente se calcula aqui, con `useMemo`, y no dentro de `useAudioLevel`:
  // el hook entrega el nivel crudo del backend, que es lo que sabe interpretar, y
  // esto es lo que sabe pintar. Separados, cada uno se puede probar por su cuenta.
  const bars = useMemo(
    () => (level.history.length === 0 ? [] : vuEnvelope(level.history).map(vuBarScale)),
    [level.history],
  );
  const now = Math.round(vuBarScale(level.value) * 100);

  return (
    <div className="flex items-center gap-3">
      <div
        className="flex h-6 flex-1 items-end gap-px rounded-sm bg-obsidian/60 p-0.5"
        role="meter"
        aria-label="Nivel de entrada"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={now}
        aria-valuetext={`${now} por ciento`}
      >
        {bars.length === 0
          ? Array.from({ length: LEDS }, (_, index) => <Led key={index} scale={0} />)
          : bars.map((scale, index) => <Led key={index} scale={scale} />)}
      </div>
      <span
        className="w-14 shrink-0 text-right font-mono text-[10px] text-slate-ink tabular-nums"
        title="Piso de ruido actual, en dBFS"
      >
        {active ? `${noiseFloorDb.toFixed(0)} dB` : "--"}
      </span>
    </div>
  );
}

/**
 * Un led.
 *
 * La escala va en el `style` y no en una clase porque depende del valor: 48 clases
 * distintas por lectura significaria 48 cadenas nuevas y la hoja de estilos tendingria
 * que generarlas. El color si es una clase, y cambia en tres tramos: verde oliva en
 * voz, naranja al limite y ambar intenso en el pico. El degradado de tres tonos que
 * pide el diseno se resuelve con umbrales y no con un `background-image`, porque un
 * gradiente sobre una barra de 4 px de ancho no llega a verse y solo cuesta un pintado
 * extra.
 */
function Led({ scale }: { scale: number }) {
  const lit = scale > 0.03;
  const color = !lit
    ? "bg-raised"
    : scale > 0.92
      ? "bg-gold"
      : scale > 0.7
        ? "bg-neon"
        : "bg-olive";
  return (
    // `flex-1 min-w-0` en vez de `w-full`: la celda mide la parte sobrante de la fila
    // y no un porcentaje del contenedor. Con 48 barras y `w-full` cada una pediria el
    // ancho entero y dependeria de que el `flex-shrink` las repartiera por igual.
    <span
      className={`vu-bar min-w-0 flex-1 rounded-[1px] ${color} ${
        lit ? "" : "vu-bar--idle"
      }`}
      style={{ height: "100%", transform: `scaleY(${scale})` }}
    />
  );
}

export const VuMeter = memo(VuMeterImpl);
