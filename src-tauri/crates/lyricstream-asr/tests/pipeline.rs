//! Tests del pipeline completo: VAD -> segmentador -> motor -> eventos.
//!
//! El test de integracion es el que exige el Sprint 3: alimentar audio sintetico
//! (y un WAV construido en memoria) al pipeline y comprobar que no hay panicos,
//! que los segmentos tienen estructura valida y que la memoria del acumulador queda
//! acotada. Todo corre sin pesos, sin DLL nativa y sin red.

use std::time::{Duration, Instant};

use lyricstream_asr::engine::{Language, SttEngine, TranscribeOptions, Transcription};
use lyricstream_asr::segmenter::{SegmentConfig, SegmentEvent, Segmenter};
use lyricstream_asr::vad::{FrameEvent, Vad, VadConfig};
use lyricstream_asr::worker::{
  hash_noise, sample_at_ms, SampleSource, SttWorker, SynthSource, WorkerConfig, WorkerStats,
};
use lyricstream_asr::EngineError;

// ---------------------------------------------------------------------------
// Sintesis de senal reutilizable
// ---------------------------------------------------------------------------

const SAMPLE_RATE: u32 = 16_000;

/// Ruido blanco determinista a la amplitud indicada, para pruebas de VAD.
fn white_noise(ms: u64, amplitude: f32, seed: u64) -> Vec<f32> {
  (0..(ms * SAMPLE_RATE as u64 / 1000))
    .map(|index| hash_noise(seed.wrapping_add(index)) * amplitude)
    .collect()
}

/// Silencio con el mismo ruido de fondo que la senal de laboratorio.
fn quiet(ms: u64) -> Vec<f32> {
  white_noise(ms, 0.003, 1)
}

/// Tono de referencia para probar el cruce por cero y el VAD.
fn tone(ms: u64, hz: f32, amplitude: f32) -> Vec<f32> {
  (0..(ms * SAMPLE_RATE as u64 / 1000))
    .map(|index| {
      let t = index as f32 / SAMPLE_RATE as f32;
      amplitude * (2.0 * std::f32::consts::PI * hz * t).sin()
    })
    .collect()
}

/// Extrae `ms` milisegundos de la senal de laboratorio a partir de `start_ms`.
///
/// Ojo con las unidades: a 16 kHz hay 16 muestras POR MILISEGUNDO. Dividir el
/// indice de muestra entre `SAMPLE_RATE` daria segundos, no milisegundos.
fn slice_ms(start_ms: u64, ms: u64) -> Vec<f32> {
  const SAMPLES_PER_MS: u64 = SAMPLE_RATE as u64 / 1000;
  let mut out = Vec::with_capacity((ms * SAMPLES_PER_MS) as usize);
  for index in 0..(ms * SAMPLES_PER_MS) {
    let absolute = (start_ms * SAMPLES_PER_MS) + index;
    out.push(sample_at_ms(absolute / SAMPLES_PER_MS, absolute));
  }
  out
}

/// Empuja muestras bloque a bloque y devuelve los eventos del VAD.
fn run_vad(vad: &mut Vad, samples: &[f32]) -> Vec<FrameEvent> {
  let frame = vad.frame_len();
  let mut events = Vec::new();
  for chunk in samples.chunks(frame) {
    if chunk.len() == frame {
      events.push(vad.push_frame(chunk));
    }
  }
  events
}

/// Motor de test que cuenta llamadas y falla si se le pasa algo invalido.
#[derive(Debug, Default)]
struct CountingEngine {
  windows: usize,
  samples: usize,
  finals: usize,
  reset_after_final: usize,
}

impl SttEngine for CountingEngine {
  fn info(&self) -> &lyricstream_asr::EngineInfo {
    // Se construye uno nuevo porque `info` devuelve una referencia prestada y el
    // motor de test no guarda ninguno: el worker solo lo usa para la UI.
    unreachable!("el worker de test no consulta info()")
  }

  fn transcribe(
    &mut self,
    samples: &[f32],
    options: TranscribeOptions,
  ) -> Result<Transcription, EngineError> {
    assert!(!samples.is_empty(), "ventana vacia");
    assert!(
      samples.iter().all(|sample| sample.is_finite()),
      "muestra no finita en la ventana"
    );
    assert!(
      samples.iter().all(|sample| (-1.0..=1.0).contains(sample)),
      "muestra fuera de rango en la ventana"
    );
    self.windows += 1;
    self.samples += samples.len();
    if options.is_final {
      self.finals += 1;
    }
    let duration_ms = samples.len() as u64 * 1000 / SAMPLE_RATE as u64;
    Ok(Transcription {
      text: format!(
        "{} {duration_ms}",
        if options.is_final { "final" } else { "parcial" }
      ),
      confidence: 0.8,
    })
  }

  fn reset(&mut self) {
    self.reset_after_final += 1;
  }
}

// ---------------------------------------------------------------------------
// VAD
// ---------------------------------------------------------------------------

#[test]
fn el_vad_abre_y_cierra_un_segmento_de_frase() {
  let mut vad = Vad::new(VadConfig::default());
  // 1 s de voz de laboratorio y 1 s de silencio: el hangover son 700 ms, asi que
  // cabe entero.
  let events = run_vad(&mut vad, &slice_ms(0, 2_000));

  let starts = events
    .iter()
    .filter(|e| **e == FrameEvent::SpeechStart)
    .count();
  let ends = events
    .iter()
    .filter(|e| **e == FrameEvent::SpeechEnd)
    .count();
  assert_eq!(
    starts, 1,
    "la frase debe abrir un unico segmento: {events:?}"
  );
  assert_eq!(
    ends, 1,
    "el silencio posterior debe cerrar el segmento: {events:?}"
  );
  assert_eq!(events[0], FrameEvent::Silence, "el onset necesita 60 ms");
  assert_eq!(
    events[2],
    FrameEvent::SpeechStart,
    "abre tras 3 bloques de voz"
  );
}

#[test]
fn el_vad_ignora_silencio_puro() {
  let mut vad = Vad::new(VadConfig::default());
  // 3 s con el ruido de fondo del laboratorio (unos -55 dBFS), muy por debajo del
  // suelo absoluto de -50 dBFS.
  let events = run_vad(&mut vad, &slice_ms(1_000, 3_000));
  assert!(
    events.iter().all(|event| *event == FrameEvent::Silence),
    "3 s de silencio no deben abrir nada: {events:?}"
  );
  assert!(!vad.is_speaking());
}

#[test]
fn el_vad_ignora_un_golpe_de_ruido_corto() {
  let mut vad = Vad::new(VadConfig::default());
  // 40 ms de tono: por debajo del onset de 60 ms, asi que ni siquiera abre segmento.
  let burst = tone(40, 200.0, 0.4);
  let events = run_vad(&mut vad, &burst);
  assert!(
    !events.contains(&FrameEvent::SpeechStart),
    "un golpe de 40 ms no debe abrir frase: {events:?}"
  );
}

#[test]
fn el_vad_separa_dos_frases_con_silencio_suficiente() {
  let mut vad = Vad::new(VadConfig::default());
  // 1 s de voz, 1 s de silencio (supera el hangover de 700 ms), 1 s de voz.
  // 1 s de voz, 1 s de silencio (supera el hangover de 700 ms), 1 s de voz, y
  // 1 s mas de silencio para que la segunda frase tambien llegue a cerrarse.
  let phrase = slice_ms(0, 1_000);
  let mut samples = phrase.clone();
  samples.extend(quiet(1_000));
  samples.extend(phrase);
  samples.extend(quiet(1_000));

  let events = run_vad(&mut vad, &samples);
  let starts = events
    .iter()
    .filter(|e| **e == FrameEvent::SpeechStart)
    .count();
  let ends = events
    .iter()
    .filter(|e| **e == FrameEvent::SpeechEnd)
    .count();
  assert_eq!(starts, 2, "dos frases claramente separadas: {events:?}");
  assert_eq!(ends, 2, "cada frase se cierra: {events:?}");
}

#[test]
fn el_vad_no_cierra_una_pausa_corta_dentro_de_la_frase() {
  let mut vad = Vad::new(VadConfig::default());
  // 1 s de voz, 300 ms de silencio (por debajo del hangover), 1 s de voz.
  let phrase = slice_ms(0, 1_000);
  let mut samples = phrase.clone();
  samples.extend(quiet(300));
  samples.extend(phrase);
  // Silencio final para cerrar el segmento y poder comprobar que se cerro UNA vez.
  samples.extend(quiet(1_000));

  let events = run_vad(&mut vad, &samples);
  let starts = events
    .iter()
    .filter(|e| **e == FrameEvent::SpeechStart)
    .count();
  assert_eq!(
    starts, 1,
    "una pausa de 300 ms no debe partir la frase: {events:?}"
  );
  let ends = events
    .iter()
    .filter(|e| **e == FrameEvent::SpeechEnd)
    .count();
  assert_eq!(ends, 1, "la frase unida se cierra una sola vez: {events:?}");
}

#[test]
fn el_piso_de_ruido_sube_con_ruido_de_fondo() {
  let mut vad = Vad::new(VadConfig::default());
  // 2 s de ruido blanco a -30 dBFS: un nivel al que un umbral fijo no llegaria.
  // 2 s de ruido blanco a -35 dBFS: el piso debe converger hacia ese nivel.
  let noise = white_noise(2_000, 0.03, 99);
  run_vad(&mut vad, &noise);
  let floor = vad.noise_floor_db();
  assert!(
    (-45.0..-25.0).contains(&floor),
    "el piso debe converger hacia los -35 dBFS del ruido, se obtuvo {floor:.1}"
  );
  // Una vez aprendido el piso, el propio ruido ya no cumple la puerta de SNR.
  let mut vad2 = Vad::new(VadConfig::default());
  let mut events = run_vad(&mut vad2, &noise);
  let after_warmup = events.split_off(50);
  assert!(
    !after_warmup.contains(&FrameEvent::SpeechStart),
    "ruido estacionario no debe abrir frase una vez aprendido el piso: {after_warmup:?}"
  );
}

#[test]
fn el_vad_rechaza_ruido_alto_sin_voz() {
  let mut vad = Vad::new(VadConfig::default());
  // Siseo paso alto: energia alta y cruce por cero de 0.60, fuera de la banda sana.
  let mut previous = 0.0f32;
  let hiss: Vec<f32> = (0..(SAMPLE_RATE as u64 * 2) as usize)
    .map(|index| {
      let white = hash_noise(31 + index as u64);
      let out = white - previous;
      previous = white;
      out * 0.15
    })
    .collect();
  let events = run_vad(&mut vad, &hiss);
  assert!(
    !events.contains(&FrameEvent::SpeechStart),
    "un siseo de -18 dBFS no es voz: {events:?}"
  );
}

#[test]
fn la_energia_de_un_bloque_tiene_sentido() {
  // Silencio digital.
  assert_eq!(Vad::rms_db(&[0.0; 320]), -90.0);
  // Senal de amplitud 1: 0 dBFS.
  let full = vec![1.0f32; 320];
  assert!((Vad::rms_db(&full) - 0.0).abs() < 0.01);
  // Mitad de amplitud: -6 dBFS.
  let half = vec![0.5f32; 320];
  assert!((Vad::rms_db(&half) + 6.02).abs() < 0.05);
}

#[test]
fn el_cruce_por_cero_distingue_tono_de_dc() {
  // 440 Hz a 16 kHz cruza 2 veces por ciclo: 440 * 320 / 16000 = 8.8 ciclos, o sea
  // ~17.6 cruces en 320 muestras.
  let zcr = Vad::zero_cross_rate(&tone(20, 440.0, 0.3));
  assert!((zcr - 0.055).abs() < 0.005, "zcr de 440 Hz = {zcr}");

  // La banda muerta es relativa al pico: la misma forma a -40 dBFS da el mismo
  // cruce por cero. Con un umbral fijo, esta senal no cruzaria nada.
  assert!(
    (Vad::zero_cross_rate(&tone(20, 440.0, 0.01)) - zcr).abs() < 0.005,
    "el cruce por cero no debe depender del volumen"
  );

  let dc = vec![0.5f32; 320];
  assert_eq!(Vad::zero_cross_rate(&dc), 0.0, "DC no cruza");

  let silence = vec![0.0f32; 320];
  assert_eq!(Vad::zero_cross_rate(&silence), 0.0, "silencio no cruza");
}

#[test]
fn el_cruce_por_cero_separa_voz_de_ruido() {
  // Voz formante sintetica: dentro de la banda sana.
  let voice = Vad::zero_cross_rate(&slice_ms(0, 20));
  assert!(
    voice > 0.005 && voice < 0.35,
    "la voz debe caer en la banda sana, dio {voice}"
  );
  // Siseo de alta frecuencia: por encima de la banda.
  let mut previous = 0.0f32;
  let hiss: Vec<f32> = (0..320)
    .map(|index| {
      let white = hash_noise(index);
      let out = white - previous;
      previous = white;
      out * 0.15
    })
    .collect();
  let hiss_zcr = Vad::zero_cross_rate(&hiss);
  assert!(
    hiss_zcr > 0.35,
    "el siseo debe quedar fuera de la banda sana, dio {hiss_zcr}"
  );
}

// ---------------------------------------------------------------------------
// Segmentador
// ---------------------------------------------------------------------------

#[test]
fn el_segmentador_emite_parciales_con_solape() {
  let cfg = SegmentConfig::default();
  let mut segmenter = Segmenter::new(cfg, 20);
  // Un tono continuo de 6 s con el hangover largo: asi el segmento NO se cierra
  // durante la prueba y se pueden ver muchos parciales. Con 1 s de voz (la senal de
  // laboratorio) no habria material para ver la ventana deslizarse: toda la frase
  // cabria en la ventana y `start_ms` seria siempre 0.
  let mut vad = Vad::new(VadConfig {
    hangover_ms: 60_000,
    ..Default::default()
  });
  let samples = tone(6_000, 150.0, 0.3);
  let frame = vad.frame_len();

  let mut partials: Vec<(u64, u64)> = Vec::new();
  let mut now = 0u64;
  for chunk in samples.chunks(frame) {
    let event = vad.push_frame(chunk);
    now += 20;
    if let SegmentEvent::Partial(window) = segmenter.push(chunk, event, now, vad.speech_ms()) {
      partials.push((window.start_ms, window.duration_ms));
    }
  }

  assert!(
    partials.len() >= 5,
    "una frase de 6 s debe dar varios parciales: {partials:?}"
  );
  // La ventana tiene un suelo de 1 s, pero un suelo no es una garantia: es un minimo
  // que se ESTIRA hacia atras tomando lo acumulado. El primer parcial sale a los
  // ~500 ms de reloj, cuando el utterance solo tiene ~440 ms (el onset se come los
  // primeros 60), asi que la ventana es todo lo que hay.
  assert_eq!(partials[0].0, 0, "la primera ventana arranca en el inicio");
  assert!(
    (400..=560).contains(&partials[0].1),
    "la primera ventana cubre todo lo acumulado, no menos: {} ms",
    partials[0].1
  );
  // La ventana CRECE con la frase y esta acotada por el techo de 5 s. Los valores
  // exactos dependen de cuando caiga el onset, asi que se comprueban las propiedades
  // y no una cifra.
  let mut previous = 0;
  for (start, len) in &partials {
    assert!(
      *len <= cfg.partial_window_ms + 40,
      "la ventana parcial nunca pasa de 5 s: {len} ms"
    );
    assert!(
      *start + *len <= now + 40,
      "la ventana no puede extenderse mas alla de lo acumulado: {start}+{len} > {now}"
    );
    assert!(
      *len >= previous,
      "la ventana no se encoge al crecer la frase: {len} ms tras {previous} ms"
    );
    previous = *len;
  }
  // Con 6 s de frase, la ventana tiene que haberse abierto y deslizado de verdad.
  let last = partials.last().unwrap();
  assert!(
    last.0 > 0,
    "las ventanas parciales deben desplazarse dentro del utterance: {partials:?}"
  );
  assert!(
    last.1 >= 5_000,
    "una frase larga debe llegar al techo de la ventana: {} ms",
    last.1
  );
  // Solape: el avance por parcial es menor que la ventana, que es lo que evita que una
  // palabra se parta entre dos ventanas.
  let stride = partials[1].0 - partials[0].0;
  assert!(
    stride < partials[1].1,
    "ventanas consecutivas solapadas, avance {stride} ms con ventana de {} ms",
    partials[1].1
  );
}

#[test]
fn la_ventana_parcial_crece_hasta_el_tope_y_no_mas() {
  // El crecimiento es la garantia de que un parcial de 1 s largo no se produce al
  // principio de una frase larga: a los 4 s la ventana ya cubre 4 s de frase.
  let cfg = SegmentConfig::default();
  assert_eq!(cfg.partial_min_ms, 1_000, "el suelo de la ventana es 1 s");
  assert_eq!(
    cfg.partial_window_ms, 5_000,
    "el techo de la ventana es 5 s"
  );
  assert!(
    (400..=600).contains(&cfg.partial_stride_ms),
    "el paso entre parciales esta en 400-600 ms: {}",
    cfg.partial_stride_ms
  );
  // El solape es `span - stride`, y con estos parametros nunca baja de 500 ms: muy
  // por encima de los 200 ms que hacen falta para no partir una palabra.
  for utterance_ms in [0, 500, 1_000, 2_000, 5_000, 9_000] {
    let span = cfg.partial_span_ms(utterance_ms);
    assert!(
      (1_000..=5_000).contains(&span),
      "ventana fuera de rango con {utterance_ms} ms de voz: {span}"
    );
    assert!(
      span.saturating_sub(cfg.partial_stride_ms) >= 200,
      "el solape cae por debajo de 200 ms con {utterance_ms} ms de voz: {span}"
    );
  }
  // Fuera del rango, la ventana se queda en el suelo o en el techo.
  assert_eq!(cfg.partial_span_ms(0), 1_000);
  assert_eq!(cfg.partial_span_ms(50_000), 5_000);
}

#[test]
fn el_segmentador_entrega_el_utterance_completo_al_final() {
  let mut segmenter = Segmenter::new(SegmentConfig::default(), 20);
  let mut vad = Vad::new(VadConfig::default());
  let samples = slice_ms(0, 3000);
  let frame = vad.frame_len();

  let mut now = 0u64;
  let mut final_window = None;
  for chunk in samples.chunks(frame) {
    let event = vad.push_frame(chunk);
    now += 20;
    match segmenter.push(chunk, event, now, vad.speech_ms()) {
      SegmentEvent::Final(window) => final_window = Some(window),
      _ => {}
    }
  }

  let window = final_window.expect("el silencio final debe cerrar el segmento");
  assert!(window.is_final);
  // 1 s de frase + 700 ms de hangover, que es lo que se acumula hasta el corte.
  assert!(
    (1_650..=1_750).contains(&window.duration_ms),
    "el final debe traer frase + hangover, no solo la ventana de 1 s: {} ms",
    window.duration_ms
  );
  assert_eq!(window.start_ms, 0);
  assert!(
    !segmenter.has_segment(),
    "el utterance se entrega y se limpia"
  );
  // El contenido se entrega vacio y la capacidad se reutiliza para el proximo
  // segmento: queda en la reserva inicial (8 bloques), no en los 1.9 MB que
  // ocuparia un utterance de 30 s.
  assert!(
    segmenter.utterance_bytes() <= 32 * 1024,
    "la capacidad debe quedar acotada tras entregar: {} bytes",
    segmenter.utterance_bytes()
  );
}

#[test]
fn el_segmentador_descarta_un_golpe_de_ruido() {
  let mut segmenter = Segmenter::new(SegmentConfig::default(), 20);
  let mut vad = Vad::new(VadConfig::default());
  let frame = vad.frame_len();
  // 120 ms de tono: supera el onset de 60 ms (asi que el VAD abre segmento) pero no
  // llega al minimo de 200 ms de voz real, que es lo que el segmentador exige.
  // Despues, silencio hasta cumplir el hangover y cerrar.
  let mut samples = tone(120, 200.0, 0.4);
  samples.extend(quiet(1_000));

  let mut now = 0u64;
  let mut discarded = false;
  for chunk in samples.chunks(frame) {
    let event = vad.push_frame(chunk);
    now += 20;
    if matches!(
      segmenter.push(chunk, event, now, vad.speech_ms()),
      SegmentEvent::Discarded { .. }
    ) {
      discarded = true;
    }
  }
  assert!(discarded, "un golpe corto se descarta");
  assert!(!segmenter.has_segment());
}

#[test]
fn el_segmentador_acota_la_memoria_del_utterance() {
  let cfg = SegmentConfig {
    max_utterance_ms: 5_000,
    ..Default::default()
  };
  let mut segmenter = Segmenter::new(cfg, 20);
  let mut vad = Vad::new(VadConfig {
    hangover_ms: 60_000, // sin cierre: solo el tope de memoria puede cortar
    ..Default::default()
  });
  let frame = vad.frame_len();
  let voice = tone(30_000, 150.0, 0.3);

  let mut now = 0u64;
  let mut finals = 0;
  for chunk in voice.chunks(frame) {
    let event = vad.push_frame(chunk);
    now += 20;
    if let SegmentEvent::Final(window) = segmenter.push(chunk, event, now, vad.speech_ms()) {
      finals += 1;
      assert!(
        window.duration_ms <= 5_400,
        "el corte por memoria ocurre cerca del tope, no mucho despues: {} ms",
        window.duration_ms
      );
    }
  }
  assert_eq!(
    finals, 1,
    "un utterance infinito se corta una vez, no por bloques"
  );
  // 30 s de audio producirian 1.9 MB si no se cortara nada.
  assert!(
    segmenter.utterance_bytes() < 2 * 1024 * 1024,
    "el acumulador no puede crecer sin limite: {} bytes",
    segmenter.utterance_bytes()
  );
}

// ---------------------------------------------------------------------------
// Worker: pipeline completo
// ---------------------------------------------------------------------------

/// Fuente que reproduce una senal finita y luego se queda muda.
struct ScriptedSource {
  samples: Vec<f32>,
  cursor: usize,
  block: usize,
}

impl SampleSource for ScriptedSource {
  fn drain(&mut self, out: &mut Vec<f32>) -> usize {
    if self.cursor >= self.samples.len() {
      return 0;
    }
    let end = (self.cursor + self.block).min(self.samples.len());
    out.clear();
    out.extend_from_slice(&self.samples[self.cursor..end]);
    self.cursor = end;
    out.len()
  }
}

fn drain_all(
  receiver: &std::sync::mpsc::Receiver<lyricstream_asr::TranscriptionSegment>,
  wait: Duration,
) -> Vec<lyricstream_asr::TranscriptionSegment> {
  let mut out = Vec::new();
  let deadline = Instant::now() + wait;
  while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
    match receiver.recv_timeout(remaining.min(Duration::from_millis(50))) {
      Ok(segment) => out.push(segment),
      Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
      Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
    }
  }
  out
}

#[test]
fn el_worker_produce_segmentos_validos_sobre_audio_sintetico() {
  // 1 s de frase (la senal de laboratorio) y 3.5 s de silencio.
  let signal = slice_ms(0, 4_500);
  let source = ScriptedSource {
    samples: signal,
    cursor: 0,
    block: 160,
  };
  let config = WorkerConfig {
    poll_interval: Duration::from_millis(1),
    ..Default::default()
  };
  let mut worker = SttWorker::start(
    Box::new(source),
    Box::new(CountingEngine::default()),
    config,
  )
  .expect("no se pudo crear el hilo stt-worker");
  let segments = drain_all(worker.segments(), Duration::from_secs(5));
  let stats = worker.stats();
  worker.stop();

  let finals: Vec<_> = segments.iter().filter(|s| s.is_final).collect();
  let partials: Vec<_> = segments.iter().filter(|s| !s.is_final).collect();
  assert_eq!(
    finals.len(),
    1,
    "una sola frase da un solo final: {segments:?}"
  );
  assert!(
    !partials.is_empty(),
    "una frase de 1 s con parciales cada 700 ms debe producir parciales: {segments:?}"
  );

  // Orden temporal: los parciales salen antes que el final.
  let first_final = segments.iter().position(|s| s.is_final).unwrap();
  assert!(
    segments[..first_final].iter().all(|s| !s.is_final),
    "no puede haber un final antes del final"
  );

  // El fragmento incluye la frase y el hangover de 700 ms que la cierra, asi que
  // 1.66 s es lo correcto para 1 s de voz.
  for segment in &segments {
    assert!(!segment.text.is_empty(), "un parcial no puede ir vacio");
    assert!(
      (0.0..=1.0).contains(&segment.confidence),
      "confianza fuera de rango: {}",
      segment.confidence
    );
    assert!(
      segment.duration_ms > 0,
      "un segmento tiene duracion positiva"
    );
    assert!(
      segment.duration_ms <= 1_800,
      "ningun segmento excede frase + hangover: {} ms",
      segment.duration_ms
    );
  }

  // El final cubre la frase entera, no solo la ventana de 1 s.
  let last = finals.last().unwrap();
  assert!(
    last.duration_ms >= 1_000,
    "el final debe traer la frase completa: {} ms",
    last.duration_ms
  );

  // Los contadores cuadran con lo emitido.
  assert_eq!(stats.segments as usize, segments.len());
  assert!(
    stats.frames > 100,
    "se procesaron bloques de audio: {}",
    stats.frames
  );
  assert!(stats.inferences >= stats.segments);
  assert_eq!(stats.errors, 0, "el motor de test nunca falla");
  assert!(
    !stats.speaking,
    "tras el silencio no queda un segmento abierto"
  );
}

#[test]
fn el_worker_ignora_ruido_sin_producir_texto() {
  // Solo ruido de fondo: no debe emitirse nada.
  let mut seed = 4u32;
  let noise: Vec<f32> = (0..SAMPLE_RATE as usize * 3)
    .map(|_| {
      seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
      ((seed >> 8) as f32 / 8_388_608.0 - 1.0) * 0.01
    })
    .collect();
  let source = ScriptedSource {
    samples: noise,
    cursor: 0,
    block: 160,
  };
  let config = WorkerConfig {
    poll_interval: Duration::from_millis(1),
    ..Default::default()
  };
  let mut worker = SttWorker::start(
    Box::new(source),
    Box::new(CountingEngine::default()),
    config,
  )
  .expect("no se pudo crear el hilo stt-worker");
  let segments = drain_all(worker.segments(), Duration::from_millis(800));
  let stats = worker.stats();
  worker.stop();

  assert!(
    segments.is_empty(),
    "el ruido de fondo no puede abrir un segmento: {segments:?}"
  );
  assert_eq!(stats.inferences, 0, "ni una sola llamada al motor");
  assert!(!stats.speaking);
}

#[test]
fn el_worker_cierra_el_segmento_al_parar() {
  // Frase sin silencio final: si el usuario para con la frase a medias, el texto
  // pendiente debe salir igualmente.
  let source = ScriptedSource {
    samples: slice_ms(0, 1200),
    cursor: 0,
    block: 160,
  };
  let config = WorkerConfig {
    poll_interval: Duration::from_millis(1),
    ..Default::default()
  };
  let mut worker = SttWorker::start(
    Box::new(source),
    Box::new(CountingEngine::default()),
    config,
  )
  .expect("no se pudo crear el hilo stt-worker");
  // Se deja hablar un poco y se corta la captura de golpe.
  std::thread::sleep(Duration::from_millis(600));
  let segments = drain_all(worker.segments(), Duration::from_millis(200));
  worker.stop();
  // Tras `stop` el hilo ha entregado el segmento abierto; se recoge lo que hubiera.
  let mut all = segments;
  all.extend(drain_all(worker.segments(), Duration::from_millis(100)));

  assert!(
    all.iter().any(|segment| segment.is_final),
    "parar con una frase abierta debe emitir su final: {all:?}"
  );
}

#[test]
fn el_worker_sobrevive_a_un_motor_que_falla() {
  struct FailingEngine {
    calls: usize,
  }
  impl SttEngine for FailingEngine {
    fn info(&self) -> &lyricstream_asr::EngineInfo {
      unreachable!()
    }
    fn transcribe(
      &mut self,
      _samples: &[f32],
      _options: TranscribeOptions,
    ) -> Result<Transcription, EngineError> {
      self.calls += 1;
      Err(EngineError::Inference("sin memoria".to_string()))
    }
  }

  let source = ScriptedSource {
    samples: slice_ms(0, 2_500),
    cursor: 0,
    block: 160,
  };
  let config = WorkerConfig {
    poll_interval: Duration::from_millis(1),
    ..Default::default()
  };
  let mut worker = SttWorker::start(
    Box::new(source),
    Box::new(FailingEngine { calls: 0 }),
    config,
  )
  .expect("no se pudo crear el hilo stt-worker");
  let segments = drain_all(worker.segments(), Duration::from_secs(3));
  let stats = worker.stats();
  worker.stop();

  assert!(
    segments.is_empty(),
    "un motor caido no emite texto: {segments:?}"
  );
  assert!(stats.errors > 0, "los fallos se cuentan");
  assert!(
    stats.frames > 50,
    "el worker sigue leyendo audio tras el fallo"
  );
  assert!(!stats.speaking);
}

#[test]
fn el_worker_propaga_el_idioma_al_motor() {
  #[derive(Default)]
  struct LanguageSpy {
    seen: std::sync::Mutex<Vec<Language>>,
  }
  impl SttEngine for LanguageSpy {
    fn info(&self) -> &lyricstream_asr::EngineInfo {
      unreachable!()
    }
    fn transcribe(
      &mut self,
      _samples: &[f32],
      options: TranscribeOptions,
    ) -> Result<Transcription, EngineError> {
      self.seen.lock().unwrap().push(options.language);
      Ok(Transcription {
        text: "x".to_string(),
        confidence: 0.5,
      })
    }
  }

  let source = ScriptedSource {
    samples: slice_ms(0, 2_500),
    cursor: 0,
    block: 160,
  };
  let config = WorkerConfig {
    poll_interval: Duration::from_millis(1),
    language: Language::Es,
    ..Default::default()
  };
  let mut worker = SttWorker::start(Box::new(source), Box::new(LanguageSpy::default()), config)
    .expect("no se pudo crear el hilo stt-worker");
  let _ = drain_all(worker.segments(), Duration::from_millis(400));
  worker.set_language(Language::En);
  assert_eq!(worker.language(), Language::En);
  let _ = drain_all(worker.segments(), Duration::from_millis(300));
  worker.stop();
}

#[test]
fn el_worker_conserva_la_memoria_acotada_durante_una_voz_larga() {
  // 20 s de voz continua con el hangover desactivado: sin el tope del segmentador el
  // acumulador creeria hasta 1.3 MB; el tope lo corta.
  let source = ScriptedSource {
    samples: tone(20_000, 150.0, 0.3),
    cursor: 0,
    // Bloques de 200 ms: el worker los consume en una vuelta de bucle en vez de
    // diez, asi que los 20 s de audio caben en la ventana de espera del test.
    block: 3_200,
  };
  let config = WorkerConfig {
    vad: VadConfig {
      hangover_ms: 60_000,
      ..Default::default()
    },
    poll_interval: Duration::from_millis(1),
    ..Default::default()
  };
  let mut worker = SttWorker::start(
    Box::new(source),
    Box::new(CountingEngine::default()),
    config,
  )
  .expect("no se pudo crear el hilo stt-worker");
  let segments = drain_all(worker.segments(), Duration::from_secs(4));
  let stats: WorkerStats = worker.stats();
  worker.stop();

  assert!(!segments.is_empty(), "una voz larga produce segmentos");
  for segment in &segments {
    assert!(
      segment.duration_ms <= 30_400,
      "el tope de 30 s se respeta: {} ms",
      segment.duration_ms
    );
  }
  assert!(stats.inferences > 0);
  // 20 s de audio en ventanas de 1 s: el trabajo de inferencia es acotado por ventana,
  // no crece con la duracion de la frase.
  assert!(
    stats.inferences as usize >= 10,
    "una voz de 20 s debe renovar parciales cada 700 ms, hubo {}",
    stats.inferences
  );
}

#[test]
fn el_sintetizador_de_pruebas_es_reproducible() {
  let first = slice_ms(0, 100);
  let second = slice_ms(0, 100);
  assert_eq!(first, second, "la senal sintetica debe ser determinista");
  assert!(first.iter().all(|sample| sample.is_finite()));
  assert!(
    first.iter().all(|sample| (-1.0..=1.0).contains(sample)),
    "la senal sintetica debe estar normalizada"
  );
}

#[test]
fn la_fuente_de_sintesis_entrega_y_luego_se_agota() {
  let mut source = SynthSource::voice_then_silence(200, 100, 160);
  let mut out = Vec::new();
  let mut total = 0;
  loop {
    total += source.drain(&mut out);
    if out.is_empty() {
      break;
    }
  }
  assert_eq!(total, 300 * 16, "entrega la duracion pedida");
  assert_eq!(source.drain(&mut out), 0, "agotada devuelve 0, no bloquea");
}
