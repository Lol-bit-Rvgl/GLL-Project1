//! Captura de audio en Windows mediante WASAPI, con cpal como unica dependencia.
//!
//! # Fuentes
//!
//! * `Loopback`: audio del sistema (Meet, YouTube, Discord...). En cpal 0.15 se
//!   captura abriendo un *input stream* sobre el dispositivo de salida: el backend
//!   WASAPI anade `AUDCLNT_STREAMFLAGS_LOOPBACK` por su cuenta
//!   (`cpal-0.15.3/src/host/wasapi/device.rs`). Ojo: en un dispositivo de render,
//!   `default_input_config()` falla con `StreamTypeNotSupported` y
//!   `supported_input_configs()` devuelve vacio, asi que la configuracion hay que
//!   sacarla de `default_output_config()`, que es el formato de mezcla del endpoint.
//! * `Mic`: dispositivo de entrada por defecto.
//!
//! # Topologia
//!
//! ```text
//!   hilo host de cpal            hilo de DSP
//!   ------------------            -----------
//!   abre el dispositivo
//!   stream WASAPI  --anillo RAW--> downmix -> FIR -> 16 kHz mono --anillo MONO--> STT
//!   callback: try_push_slice     RMS -> AtomicU32
//!   (sin asignar ni bloquear)
//! ```
//!
//! El callback de audio no reserva memoria, no toma mutexes y no bloquea: si el
//! anillo esta lleno descarta muestras y las contabiliza. Todo el DSP ocurre en el
//! hilo de DSP, que si puede permitirse asignar.
//!
//! # Por que hay dos hilos
//!
//! `cpal::Stream` es `!Send` a proposito: el stream debe crearse, usarse y soltarse
//! en el mismo hilo (cpal lo marca con `NotSendSyncAcrossAllPlatforms` por la
//! seguridad de AAudio en Android). Por eso el stream vive en un hilo host propio y
//! el motor solo guarda un `Sender` para pedirle que lo cierre. Evitar el stream
//! evita tambien `unsafe impl Send`, que seria la unica forma de meterlo en el
//! estado de Tauri.
//!
//! # Fugas de memoria
//!
//! El `RawSink` del callback y el `ConsumerArgs` del hilo de DSP referencian el
//! anillo con las dos mitades que devuelve `HeapRb::split` (ambas con un `Arc`
//! interno), no con punteros crudos: no hay nada que liberar a mano.
//! `CaptureSession::shutdown` avisa al hilo host y lo une (-> el stream y su callback
//! se destruyen ahi), despues avisa al hilo de DSP y lo une, y solo entonces suelta
//! el consumidor del anillo mono. En ese orden ninguna referencia sobrevive a su
//! dueno.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};
use ringbuf::{HeapConsumer, HeapProducer, HeapRb};
use serde::Serialize;

use super::resampler::{Resampler, TARGET_SAMPLE_RATE};

/// Capacidad del anillo crudo: 3 s de audio a 48 kHz estereo interleado
/// (96 000 muestras/s x 2 canales x 3 s = 288 000 muestras = 1,1 MiB).
pub const RAW_CAPACITY: usize = 288_000;

/// Capacidad del anillo de salida: 3 s a 16 kHz mono (48 000 muestras).
pub const MONO_CAPACITY: usize = (TARGET_SAMPLE_RATE * 3) as usize;

/// Muestras por bloque de staging del callback (2 KiB en la pila del hilo de audio).
const STAGING: usize = 512;

/// Cadencia del hilo de DSP cuando no entra audio.
const POLL: Duration = Duration::from_millis(10);

/// Cuanto baja el medidor en cada pasada sin audio. Con 0,9 el nivel cae un orden de
/// magnitud en ~0,4 s: lo bastante rapido para que la barra no se quede congelada si
/// el stream muere, y lo bastante lento para que no parpadee entre bloques, que es lo
/// que pasaria si se pusiera a cero en cuanto el anillo queda vacio (WASAPI entrega
/// bloques cada ~10 ms, asi que el anillo esta vacio la mayor parte del tiempo).
const LEVEL_RELEASE: f32 = 0.9;

/// Por debajo de este valor el medidor se publica como cero exacto, para no dejar un
/// residuo de ruido flotante.
const LEVEL_FLOOR: f32 = 1e-4;

/// Margen para abrir el dispositivo antes de darselo por fallido.
const HOST_TIMEOUT: Duration = Duration::from_secs(5);

/// Origen de la captura.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioSource {
  /// Audio del sistema (WASAPI loopback).
  Loopback,
  /// Microfono.
  Mic,
}

impl AudioSource {
  /// Acepta exactamente los identificadores que usa el frontend.
  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "loopback" => Ok(Self::Loopback),
      "mic" => Ok(Self::Mic),
      other => Err(format!(
        "origen de captura desconocido: {other:?} (usa \"loopback\" o \"mic\")"
      )),
    }
  }
}

/// Un dispositivo de audio, identificado por indice y nombre.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
  pub index: usize,
  pub name: String,
  pub is_default: bool,
}

/// Listado devuelto por `get_audio_devices`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevicesInfo {
  pub outputs: Vec<AudioDeviceInfo>,
  pub inputs: Vec<AudioDeviceInfo>,
  pub default_output: Option<String>,
  pub default_input: Option<String>,
}

/// Estado de la captura, para depuracion y para la UI.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
  pub running: bool,
  pub paused: bool,
  pub source: Option<AudioSource>,
  pub input_sample_rate: Option<u32>,
  pub input_channels: Option<u16>,
  pub output_sample_rate: u32,
  pub dropped_samples: u64,
}

/// Estado compartido entre el motor, el hilo host y el hilo de DSP.
#[derive(Debug)]
struct SharedState {
  /// Nivel RMS del audio ya preprocesado (16 kHz mono), como bits de `f32`.
  level_mono: Arc<AtomicU32>,
  /// Nivel RMS del audio crudo interleado, como bits de `f32`.
  level_raw: Arc<AtomicU32>,
  /// Muestras descartadas por desbordamiento del anillo crudo.
  dropped: Arc<AtomicU64>,
  /// Pausa logica: el callback sigue vivo pero no encola nada.
  paused: Arc<AtomicBool>,
}

impl SharedState {
  fn new() -> Self {
    Self {
      // El patron de bits de 0.0f32 es cero, asi que arrancar a cero es correcto.
      level_mono: Arc::new(AtomicU32::new(0)),
      level_raw: Arc::new(AtomicU32::new(0)),
      dropped: Arc::new(AtomicU64::new(0)),
      paused: Arc::new(AtomicBool::new(false)),
    }
  }

  fn level(&self) -> f32 {
    f32::from_bits(self.level_mono.load(Ordering::Relaxed))
  }

  fn reset_levels(&self) {
    self.level_mono.store(0f32.to_bits(), Ordering::Relaxed);
    self.level_raw.store(0f32.to_bits(), Ordering::Relaxed);
  }

  /// Sube el nivel a un valor recien medido (ataque instantaneo).
  fn set_level(&self, raw: f32, mono: f32) {
    self.level_raw.store(raw.to_bits(), Ordering::Relaxed);
    self.level_mono.store(mono.to_bits(), Ordering::Relaxed);
  }

  /// Baja el nivel cuando no entra audio. Mantener el ultimo valor (con caida) en vez
  /// de ponerlo a cero evita que el medidor oscile entre 0 y el valor real.
  fn decay_levels(&self) {
    self
      .level_mono
      .store(decay(self.level()).to_bits(), Ordering::Relaxed);
    self.level_raw.store(
      decay(f32::from_bits(self.level_raw.load(Ordering::Relaxed))).to_bits(),
      Ordering::Relaxed,
    );
  }

  /// Copia solo los mangos compartidos, para poder pasar el estado a los hilos.
  fn clone_handles(&self) -> Self {
    Self {
      level_mono: Arc::clone(&self.level_mono),
      level_raw: Arc::clone(&self.level_raw),
      dropped: Arc::clone(&self.dropped),
      paused: Arc::clone(&self.paused),
    }
  }
}

/// i16 -> f32 en [-1, 1].
///
/// Ojo: `f32::from(i16)` es una conversion numerica a secas (32767 -> 32767.0), no una
/// normalizacion de audio. Hay que dividir a mano, como hace cpal en
/// `Sample::to_float_sample`.
fn i16_to_f32(sample: i16) -> f32 {
  sample as f32 / 32_768.0
}

/// u16 -> f32 en [-1, 1]. El rango de u16 es el de i16 desplazado, asi que primero se
/// recentra en cero.
fn u16_to_f32(sample: u16) -> f32 {
  (sample as f32 - 32_768.0) / 32_768.0
}

/// Productor del anillo crudo. Vive dentro del callback de cpal.
struct RawSink {
  producer: HeapProducer<f32>,
  /// Buffer reutilizado: evita reservar memoria en el hilo de audio.
  staging: [f32; STAGING],
  dropped: Arc<AtomicU64>,
}

impl RawSink {
  fn new(producer: HeapProducer<f32>, dropped: Arc<AtomicU64>) -> Self {
    Self {
      producer,
      staging: [0.0; STAGING],
      dropped,
    }
  }

  /// Convierte y encola muestras interleadas. No bloquea ni reserva memoria: si el
  /// anillo esta lleno descarta lo que no cabe y lo contabiliza.
  fn push_slice<S: Copy>(&mut self, samples: &[S], convert: fn(S) -> f32) {
    for chunk in samples.chunks(STAGING) {
      for (slot, sample) in self.staging.iter_mut().zip(chunk) {
        *slot = convert(*sample);
      }
      let pushed = self.producer.push_slice(&self.staging[..chunk.len()]);
      let discarded = chunk.len() - pushed;
      if discarded > 0 {
        self.dropped.fetch_add(discarded as u64, Ordering::Relaxed);
      }
    }
  }
}

/// Construye el stream para un formato concreto.
///
/// cpal elige el tipo de muestra a partir del parametro `T` de `build_input_stream`, y
/// el callback recibe `&[T]` ya en ese formato. Por eso el `match` sobre
/// `SampleFormat` tiene que ocurrir *antes* de construir el stream, no dentro del
/// callback: dentro solo habria `f32`.
macro_rules! stream_for_format {
  ($device:expr, $config:expr, $sink:expr, $paused:expr, $sample:ty, $convert:expr) => {{
    let paused: Arc<AtomicBool> = $paused;
    let mut sink: RawSink = $sink;
    let convert: fn($sample) -> f32 = $convert;
    let data_callback = move |samples: &[$sample], _: &cpal::InputCallbackInfo| {
      // Pausa logica: el stream sigue abierto (no hay que recrearlo) pero no se encola
      // nada, de modo que al reanudar no hay audio rancio en el anillo.
      if paused.load(Ordering::Relaxed) {
        return;
      }
      sink.push_slice(samples, convert);
    };
    let error_callback = |err: cpal::StreamError| {
      log::error!("error del stream de audio: {err}");
    };
    $device.build_input_stream::<$sample, _, _>($config, data_callback, error_callback, None)
  }};
}

/// Datos que el hilo host devuelve al motor una vez el stream esta sonando.
#[derive(Debug, Clone)]
struct HostInfo {
  device_name: String,
  sample_rate: u32,
  channels: u16,
  sample_format: SampleFormat,
}

/// Hilo que aloja el stream de cpal. Todo lo que sea cpal ocurre aqui.
///
/// El stream se crea, se reproduce y se destruye dentro de este hilo, que es la
/// unica forma correcta de usarlo dado que `cpal::Stream` no es `Send`.
fn run_host(
  source: AudioSource,
  producer: HeapProducer<f32>,
  shared: SharedState,
  ready: SyncSender<Result<HostInfo, String>>,
  stop_rx: Receiver<()>,
) {
  // El stream se queda en este hilo mientras esperamos. Si se soltara aqui, el motor
  // recibiria un "todo bien" y luego silencio: `cpal::Stream` deja de sonar en cuanto
  // se destruye, y el callback (con el `RawSink` y su mitad del anillo) se lleva por
  // delante. Mover un `!Send` entre funciones del mismo hilo si es legal.
  let (stream, info) = match build_and_play(source, producer, shared, &ready) {
    Ok(pair) => pair,
    Err(err) => {
      // El motor esta esperando el resultado; si ya se fue, no hay nada que hacer.
      let _ = ready.send(Err(err));
      return;
    }
  };

  // El stream sigue sonando. Este hilo se queda aqui (sinixtures trabajo) hasta que
  // el motor pida parar.
  if stop_rx.recv().is_err() {
    // El motor solto el canal: en ese caso el stream se destruye igualmente al
    // salir de este ambito, asi que no hay fuga.
    log::warn!("el canal de parada del hilo host se cerro inesperadamente");
  }
  log::info!("cerrando el stream de audio de {info:?}");
  drop(stream);
}

/// Abre el dispositivo, construye el stream y lo pone en marcha.
///
/// Devuelve el stream para que quien llama lo mantenga vivo: mientras el valor exista,
/// el audio sigue fluyendo.
fn build_and_play(
  source: AudioSource,
  producer: HeapProducer<f32>,
  shared: SharedState,
  ready: &SyncSender<Result<HostInfo, String>>,
) -> Result<(Stream, HostInfo), String> {
  let (device, supported) = open_device(source)?;
  let stream_config = supported.config();
  let sample_format = supported.sample_format();

  let info = HostInfo {
    device_name: device
      .name()
      .unwrap_or_else(|_| "(dispositivo sin nombre)".to_string()),
    sample_rate: stream_config.sample_rate.0,
    channels: stream_config.channels,
    sample_format,
  };

  // Lo que ve el callback: el productor del anillo crudo, la pausa y el contador de
  // descartes. El closure captura `sink` por valor, asi que desaparece con el stream.
  let paused = Arc::clone(&shared.paused);
  let sink = RawSink::new(producer, Arc::clone(&shared.dropped));

  // `SampleFormat` es `#[non_exhaustive]`, asi que la rama `other` es obligatoria y no
  // marca codigo muerto: si cpal anade un formato, se avisa en vez de capturar en
  // silencio.
  let built = match sample_format {
    SampleFormat::F32 => stream_for_format!(device, &stream_config, sink, paused, f32, |s| s),
    SampleFormat::I16 => stream_for_format!(device, &stream_config, sink, paused, i16, i16_to_f32),
    SampleFormat::U16 => stream_for_format!(device, &stream_config, sink, paused, u16, u16_to_f32),
    other => {
      return Err(format!("formato de muestra no soportado: {other:?}"));
    }
  };

  let stream: Stream =
    built.map_err(|err| format!("no se pudo abrir el stream de captura: {err}"))?;
  stream
    .play()
    .map_err(|err| format!("no se pudo iniciar el stream de audio: {err}"))?;

  // El motor recibe una copia para registrar el estado; aqui se devuelve la original
  // para que el hilo host pueda registrarla al arrancar.
  let _ = ready.send(Ok(info.clone()));
  Ok((stream, info))
}

/// Abre el dispositivo y su configuracion segun el origen pedido.
fn open_device(source: AudioSource) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
  let host = cpal::default_host();
  match source {
    AudioSource::Loopback => {
      let device = host
        .default_output_device()
        .ok_or("no hay ningun dispositivo de salida por defecto")?;
      // Formato de mezcla del endpoint de render: es el unico que
      // `IsFormatSupported` acepta en modo loopback compartido.
      let config = device
        .default_output_config()
        .map_err(|err| format!("no se pudo leer el formato de salida: {err}"))?;
      Ok((device, config))
    }
    AudioSource::Mic => {
      let device = host
        .default_input_device()
        .ok_or("no hay ningun microfono por defecto")?;
      let config = device
        .default_input_config()
        .map_err(|err| format!("no se pudo leer el microfono: {err}"))?;
      Ok((device, config))
    }
  }
}

/// Sustituye valores no finitos por silencio. Un driver defectuoso puede entregar
/// NaN o infinito, y contaminarian el nivel y todo el audio posterior.
fn sanitize_in_place(samples: &mut [f32]) {
  for sample in samples {
    if !sample.is_finite() {
      *sample = 0.0;
    }
  }
}

/// Raiz cuadrada media, acotada a [0, 1].
fn rms(samples: &[f32]) -> f32 {
  if samples.is_empty() {
    return 0.0;
  }
  let energy = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
  energy.sqrt().clamp(0.0, 1.0)
}

/// Aplica la caida del medidor, llegando a cero exacto por debajo del suelo.
fn decay(level: f32) -> f32 {
  let next = level * LEVEL_RELEASE;
  if next < LEVEL_FLOOR { 0.0 } else { next }
}

/// Argumentos del hilo de DSP.
struct ConsumerArgs {
  raw_consumer: HeapConsumer<f32>,
  mono_producer: HeapProducer<f32>,
  shared: SharedState,
  input_rate: u32,
  channels: usize,
  shutdown: Receiver<()>,
}

/// Hilo dedicado al DSP: no toca el hilo de audio y se apaga de forma determinista
/// (espera con `recv_timeout`, nunca con `park`).
fn run_consumer(mut args: ConsumerArgs) {
  let mut resampler = Resampler::with_rates(args.input_rate, TARGET_SAMPLE_RATE);
  let mut block: Vec<f32> = Vec::with_capacity(RAW_CAPACITY / 8);
  let mut mono: Vec<f32> = Vec::new();
  let mut warned_about_backpressure = false;

  loop {
    match args.shutdown.try_recv() {
      Ok(()) | Err(TryRecvError::Disconnected) => break,
      Err(TryRecvError::Empty) => {}
    }

    if args.raw_consumer.len() == 0 {
      // Sin audio nuevo el medidor decae en lugar de congelarse ni parpadear.
      args.shared.decay_levels();
      match args.shutdown.recv_timeout(POLL) {
        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
        Err(mpsc::RecvTimeoutError::Timeout) => {}
      }
      continue;
    }

    block.clear();
    while let Some(sample) = args.raw_consumer.pop() {
      block.push(sample);
    }
    sanitize_in_place(&mut block);

    // El resampler anade a `mono`, asi que el bloque se limpia aqui.
    mono.clear();
    resampler.process_interleaved(&block, args.channels, &mut mono);

    args.shared.set_level(rms(&block), rms(&mono));

    // Nadie consume todavia (el STT llega en el Sprint 3). El nivel ya se ha
    // calculado, asi que el medidor sigue siendo correcto aunque el anillo se llene;
    // solo se pierden muestras para el reconocedor.
    if args.mono_producer.push_slice(&mono) < mono.len() && !warned_about_backpressure {
      warned_about_backpressure = true;
      log::info!(
        "anillo de 16 kHz lleno: se descartan muestras hasta que el motor de STT lea (Sprint 3)"
      );
    }
  }

  log::debug!("hilo de DSP de audio finalizado");
}

/// Una captura viva: el hilo host (que aloja el stream) y el hilo de DSP.
struct CaptureSession {
  host_stop: mpsc::Sender<()>,
  host: Option<JoinHandle<()>>,
  dsp_stop: mpsc::Sender<()>,
  dsp: Option<JoinHandle<()>>,
  /// Unico consumidor del anillo mono; lo usara el motor de STT del Sprint 3.
  mono_consumer: HeapConsumer<f32>,
}

impl CaptureSession {
  /// Apaga la cadena en orden inverso al de creacion.
  fn shutdown(self) {
    let CaptureSession {
      host_stop,
      host,
      dsp_stop,
      dsp,
      mono_consumer,
    } = self;

    // 1) Primero el hilo host: al.join() el stream se destruye ahi y con el suelta el
    //    `HeapProducer` del anillo crudo.
    let _ = host_stop.send(());
    if let Some(handle) = host {
      if let Err(err) = handle.join() {
        log::error!("el hilo host de audio ha terminado con error: {err:?}");
      }
    }
    // 2) Despues el hilo de DSP, que solo tiene sus propias mitades del anillo.
    let _ = dsp_stop.send(());
    if let Some(handle) = dsp {
      if let Err(err) = handle.join() {
        log::error!("el hilo de DSP de audio ha terminado con error: {err:?}");
      }
    }
    // 3) El anillo mono ya no lo consume nadie.
    drop(mono_consumer);
    log::info!("captura de audio detenida");
  }
}

/// Motor de captura. Se registra con `tauri::Builder::manage` y se comparte entre
/// comandos mediante `State<'_, AudioEngine>`.
pub struct AudioEngine {
  session: Mutex<Option<CaptureSession>>,
  status: Mutex<CaptureStatus>,
  shared: SharedState,
}

impl Default for AudioEngine {
  fn default() -> Self {
    Self::new()
  }
}

impl AudioEngine {
  pub fn new() -> Self {
    Self {
      session: Mutex::new(None),
      status: Mutex::new(CaptureStatus {
        output_sample_rate: TARGET_SAMPLE_RATE,
        ..Default::default()
      }),
      shared: SharedState::new(),
    }
  }

  /// Un mutex envenenado solo significa que otro hilo entro en panic con el mutex
  /// cogido; el estado sigue siendo consistente, asi que se recupera en lugar de
  /// propagar el error.
  fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
  }

  /// Enumeracion de dispositivos de entrada y salida.
  pub fn devices() -> Result<AudioDevicesInfo, String> {
    let host = cpal::default_host();
    let default_output = host
      .default_output_device()
      .and_then(|device| device.name().ok());
    let default_input = host
      .default_input_device()
      .and_then(|device| device.name().ok());

    let output_devices = host.output_devices().map_err(|err| err.to_string())?;
    let input_devices = host.input_devices().map_err(|err| err.to_string())?;

    Ok(AudioDevicesInfo {
      outputs: collect_devices(output_devices, default_output.as_deref()),
      inputs: collect_devices(input_devices, default_input.as_deref()),
      default_output,
      default_input,
    })
  }

  /// Arranca la captura y espera a que el stream este sonando.
  ///
  /// Si ya habia una sesion viva la para antes de abrir la nueva, de modo que nunca
  /// hay dos streams escribiendo en el mismo anillo.
  pub fn start(&self, source: AudioSource) -> Result<(), String> {
    let mut session = Self::lock(&self.session);
    if let Some(previous) = session.take() {
      log::info!("reiniciando la captura de audio");
      previous.shutdown();
    }

    // Un arranque nunca hereda la pausa de la sesion anterior.
    self.shared.paused.store(false, Ordering::Relaxed);
    self.shared.reset_levels();

    // `split` consume el anillo y reparte un `Arc` entre las dos mitades, asi que no
    // hace falta guardar el anillo en ningun sitio.
    let (raw_producer, raw_consumer) = HeapRb::<f32>::new(RAW_CAPACITY).split();
    let (mono_producer, mono_consumer) = HeapRb::<f32>::new(MONO_CAPACITY).split();

    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let (host_stop, host_stop_rx) = mpsc::channel();
    let host = std::thread::Builder::new()
      .name("lyricstream-audio-host".to_string())
      .spawn({
        let shared = self.shared.clone_handles();
        move || run_host(source, raw_producer, shared, ready_tx, host_stop_rx)
      })
      .map_err(|err| format!("no se pudo crear el hilo host de audio: {err}"))?;

    // El hilo host ya esta escribiendo; el anillo crudo aguanta 3 s, de modo que
    // arrancar el DSP a continuacion no pierde ni una muestra.
    let info = match ready_rx.recv_timeout(HOST_TIMEOUT) {
      Ok(Ok(info)) => info,
      Ok(Err(err)) => {
        // El hilo host ya termino al mandar el error; se recoge para no dejarlo
        // colgando.
        let _ = host.join();
        return Err(err);
      }
      Err(_) => {
        shutdown_thread(host_stop, host, "host");
        return Err(format!(
          "el hilo host de audio no respondio en {} s",
          HOST_TIMEOUT.as_secs()
        ));
      }
    };

    let (dsp_stop, dsp_stop_rx) = mpsc::channel();
    let dsp = match std::thread::Builder::new()
      .name("lyricstream-audio-dsp".to_string())
      .spawn({
        let shared = self.shared.clone_handles();
        move || {
          run_consumer(ConsumerArgs {
            raw_consumer,
            mono_producer,
            shared,
            input_rate: info.sample_rate,
            channels: info.channels as usize,
            shutdown: dsp_stop_rx,
          })
        }
      }) {
      Ok(handle) => Some(handle),
      Err(err) => {
        // El host ya esta sonando: hay que pararlo antes de devolver el error.
        shutdown_thread(host_stop, host, "host");
        return Err(format!("no se pudo crear el hilo de DSP de audio: {err}"));
      }
    };

    *Self::lock(&self.status) = CaptureStatus {
      running: true,
      paused: false,
      source: Some(source),
      input_sample_rate: Some(info.sample_rate),
      input_channels: Some(info.channels),
      output_sample_rate: TARGET_SAMPLE_RATE,
      dropped_samples: 0,
    };

    log::info!(
      "captura iniciada desde {:?} ({source:?}): {} Hz x{} {:?} -> {TARGET_SAMPLE_RATE} Hz mono",
      info.device_name,
      info.sample_rate,
      info.channels,
      info.sample_format,
    );

    *session = Some(CaptureSession {
      host_stop,
      host: Some(host),
      dsp_stop,
      dsp,
      mono_consumer,
    });
    Ok(())
  }

  /// Detiene la captura y espera a que los dos hilos terminen.
  pub fn stop(&self) -> Result<(), String> {
    let session = self.session.lock();
    if let Ok(mut guard) = session {
      if let Some(current) = guard.take() {
        current.shutdown();
      } else {
        log::debug!("stop_capture sin captura activa");
      }
    } else {
      log::warn!("no se pudo bloquear session para detener la captura");
    }
    let status = self.status.lock();
    if let Ok(mut guard) = status {
      *guard = CaptureStatus {
        output_sample_rate: TARGET_SAMPLE_RATE,
        ..Default::default()
      };
    } else {
      log::warn!("no se pudo bloquear status para restablecerlo");
    }
    self.shared.reset_levels();
    Ok(())
  }

  /// Nivel RMS instantaneo del audio preprocesado, en [0, 1]. Cero si no hay captura
  /// o si el nivel ha decaido por silencio.
  pub fn level(&self) -> f32 {
    self.shared.level()
  }

  /// Pausa o reanuda el encolado sin cerrar el stream.
  pub fn set_paused(&self, paused: bool) -> Result<bool, String> {
    if !Self::lock(&self.status).running {
      return Err("no hay ninguna captura activa".to_string());
    }
    self.shared.paused.store(paused, Ordering::Relaxed);
    Self::lock(&self.status).paused = paused;
    log::info!(
      "captura de audio {}",
      if paused { "pausada" } else { "reanudada" }
    );
    Ok(paused)
  }

  pub fn status(&self) -> CaptureStatus {
    let mut status = *Self::lock(&self.status);
    status.dropped_samples = self.shared.dropped.load(Ordering::Relaxed);
    status
  }

  /// Saca muestras del anillo de 16 kHz mono. Lo consumira el motor de STT.
  pub fn read_mono(&self, out: &mut Vec<f32>) -> usize {
    let mut session = Self::lock(&self.session);
    let Some(current) = session.as_mut() else {
      return 0;
    };
    let mut read = 0;
    while let Some(sample) = current.mono_consumer.pop() {
      out.push(sample);
      read += 1;
    }
    read
  }
}

/// Avisa a un hilo y espera a que termine, sin propagar sus errores.
fn shutdown_thread(stop: mpsc::Sender<()>, handle: JoinHandle<()>, label: &str) {
  let _ = stop.send(());
  if let Err(err) = handle.join() {
    log::warn!("no se pudo unir el hilo {label}: {err:?}");
  }
}
}

fn collect_devices<I: Iterator<Item = cpal::Device>>(
  devices: I,
  default_name: Option<&str>,
) -> Vec<AudioDeviceInfo> {
  devices
    .enumerate()
    .filter_map(|(index, device)| {
      let name = device.name().ok()?;
      let is_default = default_name == Some(name.as_str());
      Some(AudioDeviceInfo {
        index,
        name,
        is_default,
      })
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  /// El motor se puede crear y consultar sin ningun dispositivo de audio.
  #[test]
  fn el_motor_arranca_sin_dispositivos() {
    let engine = AudioEngine::new();
    assert_eq!(engine.level(), 0.0);
    assert!(!engine.status().running);
    assert_eq!(engine.status().output_sample_rate, 16_000);
    assert!(
      engine.set_paused(true).is_err(),
      "no se puede pausar sin captura"
    );
    assert!(engine.stop().is_ok(), "parar sin captura no es un error");
    assert_eq!(engine.read_mono(&mut Vec::new()), 0);
  }

  /// Parseo estricto del origen pedido por el frontend.
  #[test]
  fn parsea_el_origen() {
    assert_eq!(AudioSource::parse("loopback"), Ok(AudioSource::Loopback));
    assert_eq!(AudioSource::parse("mic"), Ok(AudioSource::Mic));
    assert!(AudioSource::parse("cable").is_err());
    assert!(
      AudioSource::parse("Loopback").is_err(),
      "el parseo es exacto"
    );
    assert!(AudioSource::parse("").is_err());
  }

  /// El listado se serializa a JSON con la forma que espera el frontend.
  #[test]
  fn serializa_el_listado_de_dispositivos() {
    let info = AudioDevicesInfo {
      outputs: vec![AudioDeviceInfo {
        index: 0,
        name: "Altavoces".to_string(),
        is_default: true,
      }],
      inputs: vec![],
      default_output: Some("Altavoces".to_string()),
      default_input: None,
    };
    let json = serde_json::to_string(&info).expect("serializa");
    assert!(json.contains("\"defaultOutput\":\"Altavoces\""), "{json}");
    assert!(json.contains("\"isDefault\":true"), "{json}");
    assert!(json.contains("\"inputs\":[]"), "{json}");
  }

  /// El origen se serializa en el formato que acepta `start_capture`.
  #[test]
  fn serializa_el_origen() {
    assert_eq!(
      serde_json::to_string(&AudioSource::Loopback).unwrap(),
      "\"loopback\""
    );
    assert_eq!(serde_json::to_string(&AudioSource::Mic).unwrap(), "\"mic\"");
  }

  /// El anillo crudo no crece sin limite: al llenarse descarta y cuenta.
  #[test]
  fn el_anillo_crudo_descarta_cuando_se_llena() {
    let (producer, mut consumer) = HeapRb::<f32>::new(4).split();
    let dropped = Arc::new(AtomicU64::new(0));
    let mut sink = RawSink::new(producer, Arc::clone(&dropped));

    // Solo caben 4 muestras; las otras 2 deben descartarse.
    sink.push_slice(&[1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0], |s| s);
    assert_eq!(dropped.load(Ordering::Relaxed), 2);
    assert_eq!(consumer.pop(), Some(1.0));
    assert_eq!(consumer.pop(), Some(2.0));
    assert_eq!(consumer.pop(), Some(3.0));
    assert_eq!(consumer.pop(), Some(4.0));
    assert_eq!(consumer.pop(), None);
  }

  /// `push_slice` no reserva memoria: procesa bloques mayores que el staging.
  #[test]
  fn el_sink_procesa_bloques_grandes() {
    let (producer, mut consumer) = HeapRb::<f32>::new(2 * STAGING).split();
    let dropped = Arc::new(AtomicU64::new(0));
    let mut sink = RawSink::new(producer, Arc::clone(&dropped));

    sink.push_slice(&[0.5f32; 2 * STAGING], |s| s);
    assert_eq!(dropped.load(Ordering::Relaxed), 0);
    for _ in 0..2 * STAGING {
      assert_eq!(consumer.pop(), Some(0.5));
    }
  }

  /// `RawSink` normaliza los enteros a `f32` en [-1, 1], como espera el resto de la
  /// cadena. Si se usara `f32::from` a secas, entrarian 32767 y -32768 en el anillo.
  #[test]
  fn el_sink_normaliza_los_enteros() {
    let (producer, mut consumer) = HeapRb::<f32>::new(4).split();
    let mut sink = RawSink::new(producer, Arc::new(AtomicU64::new(0)));

    sink.push_slice(&[i16::MAX, 0, i16::MIN], i16_to_f32);
    let first = consumer.pop().expect("deberia haber muestras");
    let second = consumer.pop().expect("deberia haber muestras");
    let third = consumer.pop().expect("deberia haber muestras");
    assert!(
      (first - 0.999_969_5).abs() < 1e-6,
      "i16::MAX deberia dar ~1,0: {first}"
    );
    assert_eq!(second, 0.0, "el cero central");
    assert_eq!(third, -1.0, "i16::MIN es el origen");

    // u16 va de 0 a 65535 con el cero en 32768.
    let (producer, mut consumer) = HeapRb::<f32>::new(4).split();
    let mut sink = RawSink::new(producer, Arc::new(AtomicU64::new(0)));
    sink.push_slice(&[0, 32_768, u16::MAX], u16_to_f32);
    assert_eq!(consumer.pop(), Some(-1.0));
    assert_eq!(consumer.pop(), Some(0.0));
    let top = consumer.pop().expect("deberia haber muestras");
    assert!(
      (top - 0.999_969_5).abs() < 1e-6,
      "u16::MAX deberia dar ~1,0: {top}"
    );
  }

  /// El hilo de DSP termina siempre, incluso sin audio.
  #[test]
  fn el_hilo_dsp_termina_si_se_cierra_el_canal() {
    let (_producer, consumer) = HeapRb::<f32>::new(RAW_CAPACITY).split();
    let (producer, _out) = HeapRb::<f32>::new(MONO_CAPACITY).split();
    let (stop_tx, stop_rx) = mpsc::channel();

    let handle = std::thread::spawn(move || {
      run_consumer(ConsumerArgs {
        raw_consumer: consumer,
        mono_producer: producer,
        shared: SharedState::new(),
        input_rate: 48_000,
        channels: 2,
        shutdown: stop_rx,
      })
    });

    // Al cerrar el canal el hilo no debe quedarse esperando para siempre.
    drop(stop_tx);
    assert!(
      handle.join().is_ok(),
      "el hilo deberia terminar al cerrar el canal"
    );
  }

  /// Alimenta el anillo crudo como lo haria WASAPI: bloques de 10 ms (480 muestras a
  /// 48 kHz) con el ritmo de un bloque cada 10 ms, hasta que le digan que pare.
  fn spawn_feeder(mut producer: HeapProducer<f32>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::spawn(move || {
      // 480 muestras = 10 ms de audio a 48 kHz mono.
      let block: Vec<f32> = (0..480)
        .map(|i| (std::f64::consts::TAU * 1_000.0 * i as f64 / 48_000.0).sin() as f32)
        .collect();
      while !stop.load(Ordering::Relaxed) {
        if producer.push_slice(&block) == 0 {
          // El hilo de DSP no llega: no hace falta insistir.
          std::thread::sleep(Duration::from_millis(1));
          continue;
        }
        std::thread::sleep(Duration::from_millis(10));
      }
    })
  }

  /// Espera a que el nivel published por el hilo de DSP supere `target`.
  fn wait_for_level(level: &AtomicU32, above: f32) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
      if f32::from_bits(level.load(Ordering::Relaxed)) > above {
        return true;
      }
      std::thread::sleep(Duration::from_millis(10));
    }
    false
  }

  /// El hilo de DSP extrae, preprocesa y actualiza el nivel mientras le mandan parar.
  #[test]
  fn el_hilo_dsp_procesa_y_se_apaga() {
    let (producer, consumer) = HeapRb::<f32>::new(RAW_CAPACITY).split();
    let (out_producer, mut out_consumer) = HeapRb::<f32>::new(MONO_CAPACITY).split();
    let (stop_tx, stop_rx) = mpsc::channel();
    let feeder_stop = Arc::new(AtomicBool::new(false));
    let feeder = spawn_feeder(producer, Arc::clone(&feeder_stop));

    let shared = SharedState::new();
    let level = Arc::clone(&shared.level_mono);

    let handle = std::thread::spawn({
      let shared = shared.clone_handles();
      move || {
        run_consumer(ConsumerArgs {
          raw_consumer: consumer,
          mono_producer: out_producer,
          shared,
          input_rate: 48_000,
          channels: 1,
          shutdown: stop_rx,
        })
      }
    });

    // El RMS de un seno de amplitud 1 es 1/sqrt(2) = 0,707.
    let measured = f32::from_bits(level.load(Ordering::Relaxed));
    assert!(
      wait_for_level(&level, 0.6),
      "el hilo de DSP deberia publicar el nivel, se obtuvo {measured}"
    );

    // Deja que circule audio con el alimentador en marcha, y solo despues lo para: si
    // se parase antes, el hilo de DSP no tendria nada que procesar.
    std::thread::sleep(Duration::from_millis(300));
    feeder_stop.store(true, Ordering::Relaxed);
    feeder.join().expect("el alimentador deberia terminar");

    let _ = stop_tx.send(());
    assert!(
      handle.join().is_ok(),
      "el hilo deberia terminar al recibir la orden"
    );

    // El anillo de 16 kHz tiene que haber recibido audio para el STT.
    let drained = std::iter::from_fn(|| out_consumer.pop()).count();
    assert!(
      drained > 1_000,
      "deberia haber audio listo para el STT, se agotaron {drained} muestras"
    );
  }

  /// El nivel cae a cero cuando deja de entrar audio, para que la UI no se congele
  /// en el ultimo valor si el stream muere.
  #[test]
  fn el_nivel_decae_en_silencio() {
    let (producer, consumer) = HeapRb::<f32>::new(RAW_CAPACITY).split();
    let (out_producer, _out) = HeapRb::<f32>::new(MONO_CAPACITY).split();
    let (stop_tx, stop_rx) = mpsc::channel();
    let feeder_stop = Arc::new(AtomicBool::new(false));
    let feeder = spawn_feeder(producer, Arc::clone(&feeder_stop));

    let shared = SharedState::new();
    let level = Arc::clone(&shared.level_mono);

    let handle = std::thread::spawn({
      let shared = shared.clone_handles();
      move || {
        run_consumer(ConsumerArgs {
          raw_consumer: consumer,
          mono_producer: out_producer,
          shared,
          input_rate: 48_000,
          channels: 1,
          shutdown: stop_rx,
        })
      }
    });

    assert!(
      wait_for_level(&level, 0.6),
      "el nivel deberia subir mientras entra audio"
    );

    // Corta el flujo: sin muestras nuevas el nivel tiene que volver a cero.
    feeder_stop.store(true, Ordering::Relaxed);
    feeder.join().expect("el alimentador deberia terminar");

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while f32::from_bits(level.load(Ordering::Relaxed)) != 0.0
      && std::time::Instant::now() < deadline
    {
      std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
      f32::from_bits(level.load(Ordering::Relaxed)),
      0.0,
      "el nivel deberia decaer a cero sin audio"
    );

    let _ = stop_tx.send(());
    let _ = handle.join();
  }

  /// Verifica que el RMS coincide con el calculo matematico.
  #[test]
  fn el_nivel_rms_es_correcto() {
    assert_eq!(rms(&[]), 0.0);
    assert_eq!(rms(&[1.0, -1.0]), 1.0);
    let medio = rms(&[0.0, 1.0]);
    assert!((medio - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    assert_eq!(rms(&[5.0, -5.0]), 1.0, "se satura a 1");
    assert_eq!(rms(&[0.0; 128]), 0.0);
  }

  /// Un NaN de un driver defectuoso no puede contaminar el nivel ni el audio.
  #[test]
  fn sanea_los_valores_no_finitos() {
    let mut samples = vec![f32::NAN, 1.0, f32::INFINITY, -1.0];
    sanitize_in_place(&mut samples);
    assert_eq!(samples, vec![0.0, 1.0, 0.0, -1.0]);
    assert!(samples.iter().all(|s| s.is_finite()));
    assert!(
      rms(&samples).is_finite(),
      "el nivel debe seguir siendo un numero"
    );

    let mut solo_nan = vec![f32::NAN; 16];
    sanitize_in_place(&mut solo_nan);
    assert_eq!(rms(&solo_nan), 0.0);
  }

  /// La capacidad de los anillos cubre al menos 2-3 s de audio.
  #[test]
  fn los_buffers_cubren_varios_segundos() {
    assert!(MONO_CAPACITY as f32 / TARGET_SAMPLE_RATE as f32 >= 2.0);
    assert!(RAW_CAPACITY as f32 / (48_000.0 * 2.0) >= 2.0);
  }
}
