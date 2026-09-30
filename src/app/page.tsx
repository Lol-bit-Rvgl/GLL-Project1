"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Tipos: espejo de las estructuras `Serialize` del lado Rust.
//
// Se redeclaran aqui a proposito, en vez de importar un paquete compartido: son
// cinco objetos y el contrato ya lo fija `cargo test` en Rust. Si uno cambia, el
// error aparece aqui al leer `undefined` en la UI, que es justo donde se nota.
// ---------------------------------------------------------------------------

/** Estado de los pesos en disco. */
type ModelInfo = {
  name: string;
  fileName: string;
  expectedPath: string;
  installed: boolean;
  sizeBytes: number;
  expectedSha256: string | null;
  actualSha256: string | null;
  verified: boolean;
  sizeOk: boolean;
};

/** Estado del motor de inferencia. */
type EngineStatus = {
  running: boolean;
  engine: string;
  /** `false` mientras el backend sea el doble de prueba. */
  realInference: boolean;
  detail: string;
  language: string;
  speaking: boolean;
  stats: WorkerStats;
};

type WorkerStats = {
  frames: number;
  inferences: number;
  segments: number;
  discarded: number;
  errors: number;
  noiseFloorDb: number;
  speaking: boolean;
};

/** Estado conjunto que devuelve `get_model_status`. */
type ModelStatus = {
  model: ModelInfo;
  engine: EngineStatus;
  downloading: boolean;
  modelsDir: string;
};

/** Progreso de descarga. */
type DownloadProgress = {
  downloaded: number;
  total: number | null;
  percent: number | null;
};

/** Como termino una descarga. */
type DownloadOutcome = {
  ok: boolean;
  error: string | null;
  model: ModelInfo | null;
};

/** Un fragmento de transcripcion. */
type TranscriptionSegment = {
  index: number;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
  language: string;
};

type AudioSource = "loopback" | "mic";
type Language = "auto" | "es" | "en";

// ---------------------------------------------------------------------------

const EVENTS = {
  download: "model-download-progress",
  downloadResult: "model-download-result",
  transcription: "transcription-segment",
  engine: "stt-engine-status",
} as const;

function bytes(value: number): string {
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exp;
  return `${scaled.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function ms(value: number): string {
  return `${(value / 1000).toFixed(1)} s`;
}

/** Un `invoke` que convierte el error de Rust a `Error` con su mensaje. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : String(err));
  }
}

export default function Home() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [segments, setSegments] = useState<TranscriptionSegment[]>([]);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<AudioSource>("loopback");
  const [language, setLanguage] = useState<Language>("auto");
  const [level, setLevel] = useState(0);
  const [capturing, setCapturing] = useState(false);

  // El nivel se sondea con un intervalo: se actualiza mucho mas a menudo de lo
  // que un evento por bloque merece, y va en un `ref` para no re-renderizar la
  // pagina entera 10 veces por segundo.
  const levelRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<ModelStatus>("get_model_status"));
      setCapturing((await call<CaptureStatus>("get_capture_status")).running);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Estado inicial y suscripciones a los eventos del backend.
  useEffect(() => {
    let alive = true;
    // La carga inicial se marca como cancelable: si el componente se desmonta
    // mientras el `invoke` esta en vuelo, el `setState` posterior se descarta en
    // vez de actualizar un arbol que ya no existe.
    void (async () => {
      try {
        const [next, capture] = await Promise.all([
          call<ModelStatus>("get_model_status"),
          call<CaptureStatus>("get_capture_status"),
        ]);
        if (!alive) return;
        setStatus(next);
        setCapturing(capture.running);
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    })();

    const unlisteners: Promise<UnlistenFn>[] = [
      listen<DownloadProgress>(EVENTS.download, (event) => {
        setProgress(event.payload);
        // El ultimo progreso no implica "instalado": puede haber fallado la
        // verificacion. Se refresca el estado para no mentir con la UI.
        if (event.payload.total !== null && event.payload.downloaded >= event.payload.total) {
          void refresh();
        }
      }),
      listen<DownloadOutcome>(EVENTS.downloadResult, (event) => {
        const { ok, error, model } = event.payload;
        // El resultado es la unica fuente fiable de "termino bien": el ultimo
        // progreso solo dice quantos bytes entraron, no si pasaron la
        // verificacion de hash.
        setProgress(null);
        if (ok) {
          setError(null);
        } else {
          setError(error ?? "la descarga del modelo fallo");
        }
        if (model) {
          setStatus((prev) => (prev ? { ...prev, model } : prev));
        } else {
          void refresh();
        }
      }),
      listen<TranscriptionSegment>(EVENTS.transcription, (event) => {
        setSegments((prev) => {
          const next = [...prev, event.payload];
          // Solo interessan las ultimas frases; la memoria del webview tambien
          // es un recurso.
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      }),
      listen<EngineStatus>(EVENTS.engine, (event) => {
        setStatus((prev) => (prev ? { ...prev, engine: event.payload } : prev));
      }),
    ];

    // El nivel solo se lee mientras hay captura; el intervalo se apaga solo.
    const timer = setInterval(() => {
      void call<number>("get_audio_level")
        .then((value) => {
          levelRef.current = value;
        })
        .catch(() => {
          levelRef.current = 0;
        });
    }, 100);
    const paint = setInterval(() => setLevel(levelRef.current), 150);

    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(paint);
      for (const unlisten of unlisteners) void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  // Un wrapper que muestra el error y bloquea los botones mientras dura la accion.
  const run = useCallback(async (action: () => Promise<void>) => {
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
  }, [refresh]);

  const onToggleCapture = () =>
    run(async () => {
      if (capturing) {
        await call("stop_capture");
      } else {
        await call("start_capture", { source });
      }
      setSegments([]);
    });

  const onToggleStt = () =>
    run(async () => {
      if (status?.engine.running) {
        await call("stop_stt");
      } else {
        if (!capturing) {
          throw new Error("arranca antes la captura de audio");
        }
        await call("start_stt");
      }
    });

  const onDownload = () =>
    run(async () => {
      setProgress(null);
      await call("download_model");
    });

  const onLanguage = (next: Language) =>
    run(async () => {
      await call("set_stt_language", { lang: next });
      setLanguage(next);
    });

  const model = status?.model;
  const engine = status?.engine;
  const downloading = status?.downloading ?? false;
  // Un fichero con el nombre correcto no basta: si el tamano o el hash no
  // cuadran, el modelo esta corrupto y hay que volver a bajarlo.
  const modelReady =
    model?.installed === true &&
    model.sizeOk &&
    (model.expectedSha256 === null || model.verified);
  const partial = segments.filter((segment) => !segment.isFinal);

  return (
    <main className="flex min-h-screen flex-col gap-6 bg-zinc-50 p-8 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">LyricStream STT</h1>
        <span className="rounded-full bg-zinc-200 px-3 py-1 font-mono text-xs dark:bg-zinc-800">
          whisper.cpp tiny
        </span>
      </header>

      {error && (
        <p className="rounded border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <Panel title="Modelo">
          <p className="text-sm">
            {modelReady ? "Instalado" : downloading ? "Descargando" : "No instalado"}
          </p>
          {model?.sizeBytes ? (
            <p className="font-mono text-xs text-zinc-500">{bytes(model.sizeBytes)}</p>
          ) : null}
          {model?.installed === true && !modelReady && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              El fichero esta corrupto: {model.sizeOk ? "el hash no cuadra" : "el tamano no cuadra"}.
              Vuelve a descargarlo.
            </p>
          )}
          {progress && <ProgressBar progress={progress} />}
          <button
            onClick={onDownload}
            disabled={busy || downloading || modelReady}
            className="mt-2 w-full rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
          >
            {downloading ? "Descargando..." : "Descargar pesos"}
          </button>
          {status?.modelsDir && (
            <p className="mt-2 truncate font-mono text-[10px] text-zinc-400" title={status.modelsDir}>
              {status.modelsDir}
            </p>
          )}
        </Panel>

        <Panel title="Captura">
          <label className="block text-sm">
            Origen
            <select
              value={source}
              disabled={busy || capturing}
              onChange={(e) => setSource(e.target.value as AudioSource)}
              className="mt-1 w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 disabled:opacity-40 dark:border-zinc-700"
            >
              <option value="loopback">Audio del sistema</option>
              <option value="mic">Microfono</option>
            </select>
          </label>
          <Meter level={level} />
          <button
            onClick={onToggleCapture}
            disabled={busy}
            className="mt-2 w-full rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
          >
            {capturing ? "Detener captura" : "Iniciar captura"}
          </button>
        </Panel>

        <Panel title="Motor">
          <p className="text-sm">
            {engine?.running ? "Escuchando" : "Detenido"}
            {engine?.speaking ? " · hablando" : ""}
          </p>
          <p className="font-mono text-xs text-zinc-500">{engine?.engine ?? "-"}</p>
          <label className="mt-2 block text-sm">
            Idioma
            <select
              value={language}
              disabled={busy}
              onChange={(e) => onLanguage(e.target.value as Language)}
              className="mt-1 w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 disabled:opacity-40 dark:border-zinc-700"
            >
              <option value="auto">Automatico</option>
              <option value="es">Espanol</option>
              <option value="en">Ingles</option>
            </select>
          </label>
          <button
            onClick={onToggleStt}
            disabled={busy || (!capturing && !engine?.running)}
            className="mt-2 w-full rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
          >
            {engine?.running ? "Parar STT" : "Iniciar STT"}
          </button>
        </Panel>
      </section>

      {engine && !engine.realInference && (
        <p className="rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {engine.detail}. El texto de abajo es de ejemplo: falta enlazar el runtime de
          inferencia.
        </p>
      )}

      <section className="flex flex-col gap-2 rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Transcripcion
          {segments.length > 0 && (
            <span className="ml-2 font-mono text-xs normal-case">
              {segments.length} fragmentos
            </span>
          )}
        </h2>
        <div className="max-h-72 min-h-24 overflow-y-auto">
          {segments.length === 0 ? (
            <p className="text-sm text-zinc-400">
              {capturing ? "Esperando voz..." : "Sin captura activa."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {partial.map((segment) => (
                <li key={`partial-${segment.index}`} className="text-sm text-zinc-400 italic">
                  {segment.text || "..."}
                </li>
              ))}
              {segments
                .filter((segment) => segment.isFinal)
                .map((segment) => (
                  <li key={segment.index} className="text-sm">
                    <span className="mr-2 font-mono text-[10px] text-zinc-400">
                      {ms(segment.startMs)}
                    </span>
                    {segment.text}
                  </li>
                ))}
            </ul>
          )}
        </div>
        {engine && (
          <p className="border-t border-zinc-200 pt-2 font-mono text-[10px] text-zinc-400 dark:border-zinc-800">
            bloques {engine.stats.frames} · ventanas {engine.stats.inferences} · fragmentos{" "}
            {engine.stats.segments} · descartados {engine.stats.discarded} · errores{" "}
            {engine.stats.errors} · ruido {engine.stats.noiseFloorDb.toFixed(1)} dB
          </p>
        )}
      </section>
    </main>
  );
}

type CaptureStatus = { running: boolean; paused: boolean };

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">{title}</h2>
      {children}
    </section>
  );
}

function ProgressBar({ progress }: { progress: DownloadProgress }) {
  const percent = progress.percent ?? (progress.total === null ? 0 : 100);
  return (
    <div className="mt-2" role="progressbar" aria-valuenow={Math.round(percent)}>
      <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full bg-blue-500 transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-1 font-mono text-[10px] text-zinc-500">
        {bytes(progress.downloaded)}
        {progress.total !== null && ` de ${bytes(progress.total)}`}
      </p>
    </div>
  );
}

function Meter({ level }: { level: number }) {
  const percent = Math.min(Math.max(level, 0), 1) * 100;
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
      <div
        className="h-full bg-emerald-500 transition-[width] duration-100"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
