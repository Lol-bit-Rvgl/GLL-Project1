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
  // La fila es SIEMPRE de `LEDS` barras, y no de "tantas como muestras haya en el
  // historial". Con lo segundo, durante los primeros ~4,8 s de cada captura el
  // historial se llenaba a 10 muestras por segundo y la fila crecia de 1 a 48 LEDs:
  // medido sobre la app en ejecucion, 28, 43 y 48. Como cada barra es `flex-1`, al
  // repartirse el ancho otra vez el medidor cambiaba de tamano en cada repintado, y un
  // historial a medias ademas sugiere una escala mas corta de la que hay. Las muestras
  // que todavia no existen van al suelo, que en un histograma es indistinguible de
  // silencio, y el extremo derecho sigue siendo siempre la muestra mas reciente.
  const scales = useMemo(() => {
    // Apagado no es "silencio", es "no hay nada que medir": fila entera a cero, que es
    // como se apaga el medidor. Sin esta rama la de abajo dibujaria el suelo y
    // pareceria que hay entrada con el motor parado.
    if (!active) return Array.from({ length: LEDS }, () => 0);
    // Ojo con el `.map(vuBarScale)` aqui, que es la forma natural de escribirlo y esta
    // mal. `map` pasa `(valor, indice, array)` y el segundo parametro de `vuBarScale` es
    // `floor`, asi que el indice se colaba como suelo. Con el nivel en [0, 1] la
    // comparacion `valor <= indice` era siempre cierta y la funcion devolvia el indice:
    // medido en vivo, la fila salia `scaleY(0)`, `scaleY(1)`, ... `scaleY(47)`, o sea
    // una escalera creciente de 0 a 940 px de alto en vez del nivel de audio. La flecha
    // es para que no vuelva a colarse el indice como segundo argumento.
    const envelope = vuEnvelope(level.history).map((value) => vuBarScale(value));
    if (envelope.length >= LEDS) return envelope.slice(-LEDS);
    return [
      ...Array.from({ length: LEDS - envelope.length }, () => vuBarScale(0)),
      ...envelope,
    ];
  }, [active, level.history]);
  const now = Math.round(vuBarScale(level.value) * 100);

  return (
    // El grupo necesita ancho propio, y con tope. Sin `min-w`, este div no crece: es
    // un hijo del pie, que es `flex-wrap justify-between`, y como no lleva `flex-1` se
    // ajusta a su contenido. Entonces la pista, que si es `flex-1`, se quedaba sin
    // espacio: medido en vivo, 51 px para 48 barras, y con `gap-px` los 47 huecos se
    // comian 47 de esos 51 px. Cada barra salia a 0,04 px y el navegador la pintaba a
    // 0 px de dispositivo, o sea que el medidor era invisible siempre, incluso con la
    // fila entera encendida. El max evita el otro extremo, que es el mismo medidor con
    // barras de 24 px de ancho.
    <div className="flex min-w-[300px] max-w-[420px] flex-1 items-center gap-3">
      <div
        className="flex h-6 flex-1 items-end gap-px rounded-sm bg-obsidian/60 p-0.5"
        role="meter"
        aria-label="Nivel de entrada"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={now}
        aria-valuetext={`${now} por ciento`}
      >
        {scales.map((scale, index) => (
          <Led key={index} scale={scale} />
        ))}
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
