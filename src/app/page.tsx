"use client";

/**
 * La ventana unica de la app: barra de control, canal de texto, vumetro y export.
 *
 * # Un boton, no dos
 *
 * Antes habia "Iniciar captura" y "Iniciar STT" por separado, y el segundo fallaba
 * con "arranca antes la captura de audio" si se pulsaba en el orden equivocado. Aqui
 * `onToggle` hace las dos llamadas en el orden correcto y el texto del boton refleja
 * la fase real, leida del backend. El usuario no tiene que saber el orden.
 *
 * # El estado del motor manda sobre el de la UI
 *
 * `phase` no es un `useState` propio: se deriva de `engine.running` y de si hay
 * captura. El evento `stt-engine-status` llega tanto al arrancar como al parar, asi
 * que si el worker muere por su cuenta el boton vuelve a "Iniciar" solo. Derivar lo
 * evita; un boton de play/pause que miente es el peor fallo posible en una UI de
 * captura.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { ControlBar } from "@/components/ControlBar";
import { ExportMenu } from "@/components/ExportMenu";
import { MiniOverlay } from "@/components/MiniOverlay";
import { DockedPlayer } from "@/components/player/DockedPlayer";
import { TranscriptStream } from "@/components/TranscriptStream";
import { VuMeter } from "@/components/VuMeter";
import { bytes } from "@/lib/format";
import { bookmarkedBlocks } from "@/lib/transcript";
import { useShortcuts } from "@/lib/useShortcuts";
import { useTranscript } from "@/lib/useTranscript";
import { useDuckWhileTranscribing } from "@/lib/player/useMusicPlayer";
import { EVENTS } from "@/lib/types";
import type {
  AudioSource,
  DownloadOutcome,
  DownloadProgress,
  EnginePhase,
  Language,
  MiniModeStatus,
  ModelStatus,
} from "@/lib/types";

/** Un `invoke` que convierte el error de Rust a `Error` con su mensaje. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : String(err));
  }
}

export default function Home() {
  const transcript = useTranscript();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<AudioSource>("loopback");
  const [language, setLanguage] = useState<Language>("auto");
  const [capturing, setCapturing] = useState(false);
  // Activado por defecto, y es una decision: con loopback la musica entra en la
  // transcripcion, y un historial lleno de letras ajenas es justo lo que la app
  // promete no hacer. El fallo en sentido contrario -que la musica este un momento
  // mas baja- se ve en el control de volumen, que se pinta en ambar mientras dura.
  const [duckMusic, setDuckMusic] = useState(true);
  // Modo mini-ventana. El estado autoritativo es el del backend, porque el tamano y el
  // `always_on_top` los fija el SO y la UI solo los refleja. Aqui se guarda una copia
  // para pintar, y se sincroniza al montar y con el evento `mini-mode-changed`.
  const [mini, setMini] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [next, capture] = await Promise.all([
        call<ModelStatus>("get_model_status"),
        call<{ running: boolean }>("get_capture_status"),
      ]);
      setStatus(next);
      setCapturing(capture.running);
      return next;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, []);

  // Estado inicial y suscripciones. Un unico efecto para todos los listeners: si se
  // separasen, un desmontaje a mitad de la suscripcion dejaria un `listen` colgado,
  // emitiendo a una ventana que ya no existe.
  useEffect(() => {
    let alive = true;
    // La carga inicial va dentro de un IIFE asincrono. `refresh` escribe en estado,
    // y un `setState` sincrono en el cuerpo del efecto fuerza un segundo render de
    // toda la pagina nada mas montar, que en una app de texto se nota.
    void (async () => {
      if (alive) await refresh();
      // El modo mini se lee del backend al montar. Si la webview se recarga con la mini
      // activa, sin esto la UI pintaria la ventana grande mientras el SO muestra la
      // pequena, y los botones de la cabecera quedarian fuera de la pantalla.
      try {
        const estado = await call<MiniModeStatus>("get_mini_mode");
        if (alive) setMini(estado.active);
      } catch {
        // Sin Tauri (navegador de desarrollo) el comando no existe: se sigue en modo
        // normal, que es el unico que tiene sentido sin ventana nativa.
      }
    })();

    const subscriptions = [
      listen<DownloadProgress>(EVENTS.download, (event) => {
        if (!alive) return;
        setProgress(event.payload);
        // El ultimo progreso no implica "instalado": puede haber fallado la
        // verificacion de hash. El resultado es lo que dice si termino bien.
        if (
          event.payload.total !== null &&
          event.payload.downloaded >= event.payload.total
        ) {
          void refresh();
        }
      }),
      listen<DownloadOutcome>(EVENTS.downloadResult, (event) => {
        if (!alive) return;
        const { ok, error: failure, model } = event.payload;
        setProgress(null);
        if (ok) {
          setError(null);
          if (model) {
            setStatus((prev) => (prev ? { ...prev, model } : prev));
          } else {
            void refresh();
          }
        } else {
          setError(failure ?? "la descarga del modelo fallo");
        }
      }),
      // El backend emite el cambio ademas de responder al comando, para que un cambio
      // que no venga de la UI (el usuario redimensiona a mano, o el SO restaura la
      // ventana) tambien actualice lo que se pinta.
      listen<MiniModeStatus>(EVENTS.miniMode, (event) => {
        if (!alive) return;
        setMini(event.payload.active);
      }),
    ];

    return () => {
      alive = false;
      for (const item of subscriptions) void item.then((fn) => fn()).catch(() => {});
    };
  }, [refresh]);

  // Un wrapper que muestra el error y bloquea los botones mientras dura la accion.
  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  const engineLive = status?.engine.running === true;

  // Va en la pagina y no en el reproductor porque la regla es de la transcripcion, no
  // del audio: depende de que el worker este vivo, que es un dato del backend.
  useDuckWhileTranscribing(engineLive, duckMusic);

  const onToggle = () =>
    run(async () => {
      if (engineLive) {
        // Primero el worker: lee del anillo de muestras, asi que mientras siga vivo
        // la captura sigue escribiendo en un anillo sin lector. Al reves, el worker
        // se quedaria esperando audio que ya no llega.
        await call("stop_stt");
        await call("stop_capture");
        setCapturing(false);
        return;
      }
      if (!capturing) {
        await call("start_capture", { source });
        setCapturing(true);
      }
      await call("start_stt");
    });

  const onDownload = () =>
    run(async () => {
      setProgress(null);
      await call("download_model");
    });

  const onSourceChange = (next: AudioSource) => {
    // El selector esta desactivado mientras hay captura, asi que esto solo cambia la
    // fuente para el proximo arranque. Cambiarla en caliente exigiria parar el
    // worker y reabrir el dispositivo, y eso se hace con el boton, no por sorpresa.
    setSource(next);
  };

  const onLanguageChange = (next: Language) =>
    run(async () => {
      // El backend acepta el cambio con el worker vivo y lo propaga al motor, asi
      // que no hace falta parar nada para cambiar el idioma.
      await call("set_stt_language", { lang: next });
      setLanguage(next);
    });

  /*
   * El modo mini NO pasa por `run`.
   *
   * `run` pone `busy` a true y bloquea los botones, que es lo correcto para una accion
   * que puede tardar. Cambiar el tamano de la ventana es instantaneo, y bloquear la barra
   * entera un instante hace parpadear el boton maestro cada vez que se entra o se sale
   * del modo. El error se muestra igual, que es lo unico que hace falta.
   */
  const onToggleMini = useCallback(async () => {
    try {
      const estado = await call<MiniModeStatus>("toggle_mini_mode");
      setMini(estado.active);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  /*
   * Marcar con el atajo, sin saber de bloques.
   *
   * `Ctrl+B` marca la ULTIMA frase. El id se lee de `blocks` en el momento del atajo, no
   * se guarda una referencia: entre el render y la pulsacion puede haber llegado un
   * bloque nuevo, y marcar el penultimo por un render viejo es justo el fallo que este
   * cierre evita.
   *
   * Los callbacks se toman sueltos y no del objeto `transcript` entero: ese objeto se
   * recrea en cada render, asi que usarlo como dependencia volveria a suscribir el
   * listener de teclado en cada parcial. Los tres que se usan son estables.
   */
  const { toggleBookmark, openSearch, closeSearch, searchOpen, blocks } = transcript;

  const onShortcutBookmark = useCallback(() => {
    const ultimo = blocks.at(-1);
    if (ultimo !== undefined) toggleBookmark(ultimo.id);
  }, [blocks, toggleBookmark]);

  const onShortcutSearch = useCallback(() => {
    if (searchOpen) {
      closeSearch();
    } else {
      openSearch();
    }
  }, [closeSearch, openSearch, searchOpen]);

  useShortcuts({
    onToggleBookmark: onShortcutBookmark,
    onOpenSearch: openSearch,
    onCloseSearch: closeSearch,
    searchOpen,
    canBookmark: blocks.length > 0,
  });

  const model = status?.model;
  // El del hook manda: lo refresca el sondeo de 2 s y el evento de arranque y parada.
  // El de `status` solo se actualiza cuando termina una accion, asi que durante una
  // sesion larga seria el estado del arranque.
  const engine = transcript.engine ?? status?.engine;
  const downloading = status?.downloading === true;
  // Un fichero con el nombre correcto no basta: si el tamano o el hash no cuadran,
  // el modelo esta corrupto y hay que volver a bajarlo.
  const modelReady =
    model?.installed === true &&
    model.size_ok &&
    (model.expected_sha256 === null || model.verified);

  const phase: EnginePhase = engineLive
    ? "transcribiendo"
    : capturing
      ? "capturando"
      : "reposo";

  const marcados = useMemo(() => bookmarkedBlocks(transcript.blocks), [transcript.blocks]);

  /*
   * En mini se pinta la ventana entera y se sale ANTES de montar el resto.
   *
   * No es un `hidden` sobre la maqueta normal: es un arbol distinto. Dejar montado el
   * historial con la ventana a 450x250 obligaria a que el canal, el vumetro y el dock
   * se pintasen para luego esconderlos, y ademas seguirian recibiendo el scroll y el
   * foco. Con dos arboles, el modo mini no arrastra nada del modo grande y se puede
   * medir por separado.
   */
  if (mini) {
    return (
      <MiniOverlay
        // El texto vivo es el parcial en curso; si no hay frase abierta, la ULTIMA
        // cerrada. No se le pasa `transcript.text`, que es la transcripcion ENTERA: a
        // 450x250 eso pintaria el historial completo en un parrafo.
        liveText={
          transcript.interim.trim() !== ""
            ? transcript.interim
            : (transcript.blocks.at(-1)?.text ?? "")
        }
        speaking={transcript.speaking}
        capturing={capturing}
        engineReady={engine?.real_inference ?? false}
        hasText={transcript.blocks.length > 0 || transcript.interim.trim() !== ""}
        bookmarks={marcados.length}
        onToggle={onToggle}
        onExit={onToggleMini}
      />
    );
  }

  return (
    // `relative` para que el halo de fondo quede detras del contenido, y el halo como
    // hermano en vez de fondo del `main`: el `main` es opaco y taparia su propio
    // gradiente.
    <main className="relative flex h-dvh flex-col overflow-hidden bg-obsidian text-snow">
      <div className="ambient-glow" aria-hidden="true" />
      <ControlBar
        phase={phase}
        source={source}
        busy={busy}
        engineReady={engine?.real_inference ?? false}
        modelReady={modelReady}
        downloading={downloading}
        speaking={transcript.speaking}
        duckMusic={duckMusic}
        bookmarks={marcados.length}
        canBookmark={transcript.blocks.length > 0}
        searchOpen={transcript.searchOpen}
        mini={mini}
        onToggle={onToggle}
        onSourceChange={onSourceChange}
        onDownloadModel={onDownload}
        onDuckMusicChange={setDuckMusic}
        onToggleBookmark={onShortcutBookmark}
        onToggleSearch={onShortcutSearch}
        onToggleMini={onToggleMini}
      />

      {error && (
        <p
          role="alert"
          className="border-b border-red-950/60 bg-red-950/30 px-6 py-2 text-xs text-red-300"
        >
          {error}
        </p>
      )}

      {engine && !engine.real_inference && (
        <p
          role="status"
          className="border-b border-neon/20 bg-neon/[0.07] px-6 py-2 text-xs text-ember"
        >
          {engine.detail}. No se transcribe de verdad hasta que el runtime este
          desplegado.
        </p>
      )}

      {downloading && progress && (
        <div className="border-b border-neon/12 px-6 py-2">
          <DownloadBar progress={progress} />
        </div>
      )}

      <TranscriptStream
        blocks={transcript.blocks}
        interim={transcript.interim}
        speaking={transcript.speaking}
        stickToBottom={transcript.stickToBottom}
        onStickChange={transcript.setStick}
        engineReady={engine?.real_inference ?? false}
        capturing={capturing}
        query={transcript.query}
        setQuery={transcript.setQuery}
        searchOpen={transcript.searchOpen}
        matchCount={transcript.matchCount}
        onToggleBookmark={transcript.toggleBookmark}
        onDismissSearch={transcript.closeSearch}
      />

      {/*
        El menu de exportar se queda en la franja de arriba del dock, y NO dentro de el.

        Lleva el recuento de palabras, que cambia con cada bloque cerrado. Si viviera
        dentro de `DockedPlayer` pasaria a formar parte del subarbol que se repinta cuatro
        veces por segundo con la posicion del audio, y el historial entero se repintaria
        con cada avance de la cancion. Esa separacion es el motivo de que el motor este
        fuera de React; este menu es la prueba de que sigue valiendo. El dock lleva solo
        el idioma, que cambia una vez cada varias frases.
      */}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-neon/12 bg-panel/60 px-6 py-2.5 backdrop-blur">
        <VuMeter
          active={capturing}
          noiseFloorDb={engine?.stats.noise_floor_db ?? -90}
        />
        <ExportMenu
          blocks={transcript.blocks}
          interim={transcript.interim}
          language={engine?.language ?? language}
          endMs={transcript.endMs}
          onClear={transcript.clear}
        />
      </footer>

      <DockedPlayer
        source={source}
        capturing={capturing}
        language={language}
        onLanguageChange={onLanguageChange}
        busy={busy}
      />
    </main>
  );
}

function DownloadBar({ progress }: { progress: DownloadProgress }) {
  // Sin total no hay porcentaje posible: se muestra lo descargado en vez de una barra
  // vacia, que parece un fallo.
  const percent = progress.percent ?? 0;
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-1 flex-1 overflow-hidden rounded-full bg-obsidian"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {/* Escala en vez de ancho, como el resto de barras del panel: durante una
            descarga el ancho cambia muchas veces por segundo y relayout es lo que
            mas se nota en un portatil. */}
        <div
          className="h-full w-full origin-left rounded-full bg-gradient-to-r from-neon to-flare
                     transition-transform duration-200"
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      </div>
      <span className="font-mono text-[10px] text-slate-ink tabular-nums">
        {bytes(progress.downloaded)}
        {progress.total !== null && ` de ${bytes(progress.total)}`}
        {" · "}
        {Math.round(percent)}%
      </span>
    </div>
  );
}
