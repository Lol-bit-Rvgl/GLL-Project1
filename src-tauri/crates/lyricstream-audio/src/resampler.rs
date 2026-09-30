//! Preprocesado de audio en Rust puro: cualquier tasa de entrada -> 16 kHz mono `f32`.
//!
//! Sin crates externos y sin asignaciones por bloque, pensado para ejecutarse en el
//! hilo consumidor de la cadena de captura (nunca en el callback de audio, que debe
//! ser de tiempo real).
//!
//! La cadena es: downmix a mono -> filtro FIR anti-alias (solo si hay decimacion)
//! -> remuestreo por interpolacion lineal con estado entre bloques.
//!
//! Nota sobre el estado entre bloques: WASAPI entrega bloques de ~10 ms. Remuestrear
//! cada bloque por separado produciria cortes y clicks en las fronteras, asi que se
//! conservan la ultima muestra consumida (`carry`) y la fase fraccionaria (`frac`)
//! de una llamada a la siguiente.

/// Tasa de muestreo que espera el reconocedor de voz.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Coeficientes del FIR anti-alias. Impar => fase lineal exacta.
///
/// 127 taps dan una banda de transicion de ~1,5 kHz a 48 kHz, suficiente para que un
/// tono a 12 kHz (por encima del Nyquist de salida) quede rechazado con margen de
/// sobra. Con 63 taps solo se conseguian ~18 dB, justo por debajo de lo que hace
/// falta.
/// El retardo que esto anade son 63 muestras de entrada (~1,3 ms a 48 kHz), constante
/// y sin efecto para el reconocedor de voz.
const DEFAULT_TAPS: usize = 127;

/// Margen sobre la frecuencia de corte de Nyquist de la salida; deja sitio a la
/// banda de transicion del filtro.
const CUTOFF_MARGIN: f64 = 0.88;

/// Amplitud maxima garantizada a la salida.
const PEAK: f32 = 1.0;

/// FIR de fase lineal (ventana de Hann) con estado, para evitar el aliasing que
/// apareceria al decimar de 44,1/48 kHz a 16 kHz.
///
/// Es un filtro simetrico, asi que la senal de salida esta retardada exactamente
/// `latency()` muestras respecto a la entrada. Ese retardo (~0,6 ms a 48 kHz) es
/// constante y no afecta al reconocedor de voz.
struct LowPass {
  taps: Vec<f32>,
  /// Buffer circular con las ultimas `taps.len()` muestras de entrada.
  history: Vec<f32>,
  pos: usize,
}

impl LowPass {
  /// `cutoff` va en ciclos por muestra: 0 es un filtro cerrado y 0,5 deja pasar hasta
  /// el Nyquist de la entrada.
  fn new(cutoff: f64) -> Self {
    let n = DEFAULT_TAPS;
    let mid = n as f64 / 2.0;
    let mut taps = Vec::with_capacity(n);
    for i in 0..n {
      let k = i as f64 - mid;
      let sinc = if k.abs() < f64::EPSILON {
        2.0 * cutoff
      } else {
        (std::f64::consts::TAU * cutoff * k).sin() / (std::f64::consts::PI * k)
      };
      // Ventana de Hann: suaviza los bordes y reduce el ringing del truncado.
      let window = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / (n as f64 - 1.0)).cos();
      taps.push((sinc * window) as f32);
    }
    // Normaliza la ganancia en DC para no alterar el nivel de la senal.
    let sum: f32 = taps.iter().sum();
    for tap in taps.iter_mut() {
      *tap /= sum;
    }
    Self {
      taps,
      history: vec![0.0; n],
      pos: 0,
    }
  }

  /// Retardo del filtro, en muestras de entrada.
  fn latency(&self) -> usize {
    (self.taps.len() - 1) / 2
  }

  /// Consume un bloque y escribe un filtro por cada muestra de entrada.
  ///
  /// No se adelantan ceros de relleno: la historia arranca a cero y el filtro produce
  /// por cada muestra, ni una mas ni una menos. Asi la cuenta de muestras de salida la
  /// fija solo la relacion de remuestreo, que es lo que exigen los tests y lo que
  /// espera el reconocedor de voz.
  fn process_block(&mut self, input: &[f32], out: &mut Vec<f32>) {
    for &sample in input {
      self.push(sample, out);
    }
  }

  fn push(&mut self, sample: f32, out: &mut Vec<f32>) {
    let n = self.taps.len();
    self.history[self.pos] = sample;
    self.pos = if self.pos + 1 == n { 0 } else { self.pos + 1 };
    // `pos` apunta ahora a la muestra mas antigua, que es la que multiplica
    // por el ultimo coeficiente del FIR simetrico.
    let mut acc = 0.0f32;
    let mut idx = self.pos;
    for &tap in self.taps.iter().rev() {
      acc += tap * self.history[idx];
      idx = if idx + 1 == n { 0 } else { idx + 1 };
    }
    out.push(acc);
  }
}

/// Remuestrador con estado: convierte audio multicanal a mono `f32` a `output_rate`.
pub struct Resampler {
  input_rate: u32,
  output_rate: u32,
  /// Samples de entrada por sample de salida.
  step: f64,
  /// Posicion, en muestras de entrada, de la proxima muestra de salida que toca
  /// emitir. Es la fase que se arrastra de un bloque al siguiente.
  next_pos: f64,
  /// Cuantas muestras de entrada se han consumido en total. Necesario porque
  /// `next_pos` es una posicion del flujo entero y cada bloque solo ve indices
  /// relativos: sin este contador, el segundo bloque en adelante no emitiria nada.
  input_pos: f64,
  /// Ultima muestra de entrada consumida, para poder interpolar hacia la actual.
  prev: f32,
  low_pass: Option<LowPass>,
  /// Buffers reutilizados para no reservar memoria en cada bloque.
  mono_scratch: Vec<f32>,
  filtered_scratch: Vec<f32>,
}

impl Resampler {
  /// Remuestrea a la tasa que usa el reconocedor de voz.
  pub fn new(input_rate: u32) -> Self {
    Self::with_rates(input_rate, TARGET_SAMPLE_RATE)
  }

  pub fn with_rates(input_rate: u32, output_rate: u32) -> Self {
    let input_rate = input_rate.max(1);
    let output_rate = output_rate.max(1);
    let step = input_rate as f64 / output_rate as f64;
    // El Nyquist de la salida, en ciclos por muestra de la entrada, es `0.5 / step`
    // (a 48 kHz -> 16 kHz: 1/6, es decir 8 kHz de 24 kHz). El margen baja un poco de
    // ahi para que la banda de transicion del FIR quepa dentro del hueco antes de que
    // la senal empiece a plegarse sobre si misma.
    let low_pass = if input_rate > output_rate {
      let cutoff = 0.5 * CUTOFF_MARGIN / step;
      debug_assert!(
        (0.0..=0.5).contains(&cutoff),
        "el corte debe quedar por debajo del Nyquist de entrada"
      );
      Some(LowPass::new(cutoff))
    } else {
      None
    };
    Self {
      input_rate,
      output_rate,
      step,
      // La primera muestra de salida va en la posicion 0 de la entrada, sin retraso.
      next_pos: 0.0,
      input_pos: 0.0,
      prev: 0.0,
      low_pass,
      mono_scratch: Vec::new(),
      filtered_scratch: Vec::new(),
    }
  }

  pub fn input_rate(&self) -> u32 {
    self.input_rate
  }

  pub fn output_rate(&self) -> u32 {
    self.output_rate
  }

  /// Latancia total del preprocesado, en muestras de salida.
  pub fn latency(&self) -> usize {
    match &self.low_pass {
      Some(lp) => (lp.latency() as f64 / self.step).round() as usize,
      None => 0,
    }
  }

  /// Consume audio interleado multicanal y **anade** mono `f32` a `out`.
  ///
  /// Los canales se promedian antes de remuestrear, tal como pide el modelo de
  /// reconocimiento de voz (un solo canal, energia media).
  ///
  /// Anade en vez de reemplazar: es la operacion que se llama bloque a bloque desde el
  /// hilo de DSP, y el estado interno (historia del FIR, fase) es lo que mantiene la
  /// continuidad. Quien quiera empezar de cero limpia `out` antes de llamar.
  pub fn process_interleaved(&mut self, input: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
      return self.process_mono(input, out);
    }

    let mut mono = std::mem::take(&mut self.mono_scratch);
    mono.clear();
    mono.reserve(input.len() / channels + 1);
    let scale = 1.0 / channels as f32;
    // `chunks_exact` descarta una trama parcial; WASAPI siempre entrega muestras
    // intereas y el largo de bloque es multiplo del numero de canales.
    for frame in input.chunks_exact(channels) {
      mono.push(frame.iter().sum::<f32>() * scale);
    }
    self.process_mono(&mono, out);
    self.mono_scratch = mono;
  }

  /// Consume audio mono `f32` y **anade** mono `f32` a `out`. Mismo contrato que
  /// `process_interleaved`.
  pub fn process_mono(&mut self, input: &[f32], out: &mut Vec<f32>) {
    match self.low_pass.as_mut() {
      None => self.interpolate(input, out),
      Some(low_pass) => {
        let mut filtered = std::mem::take(&mut self.filtered_scratch);
        filtered.clear();
        low_pass.process_block(input, &mut filtered);
        self.interpolate(&filtered, out);
        self.filtered_scratch = filtered;
      }
    }
  }

  /// Remuestreo conservando la fase entre llamadas.
  ///
  /// Se recorre la entrada y, para cada posicion `next_pos` que ya ha llegado, se
  /// emite una muestra interpolada entre las dos muestras de entrada que la rodean.
  /// Al terminar `next_pos` queda en la posicion pendiente, de modo que un flujo
  /// continuo de bloques produce exactamente la misma salida que si se procesara de
  /// una sola vez.
  ///
  /// La primera salida cae en la posicion 0 (sin muestras de silencio iniciales) y
  /// `next_pos` avanza `step` cada vez, asi que el numero de muestras de salida lo
  /// fija solo la relacion de remuestreo.
  ///
  /// Cuando `step` es entero (el caso habitual, 48 kHz -> 16 kHz) la posicion cae
  /// siempre sobre una muestra de entrada y sale una decimacion exacta de la senal ya
  /// filtrada, que es justo lo que se quiere: sin imaginacion y con el anti-alias del
  /// FIR haciendo su trabajo.
  fn interpolate(&mut self, input: &[f32], out: &mut Vec<f32>) {
    for (index, &sample) in input.iter().enumerate() {
      // Posicion de esta muestra en el flujo completo, no en el bloque.
      let current = self.input_pos + index as f64;
      // Entre la muestra anterior y la actual se puede interpolar en todo el intervalo
      // [current - 1, current]. En la primera del flujo no hay anterior, asi que el
      // unico valor definible es el propio `sample`.
      let (base_pos, base_val) = if current == 0.0 {
        (0.0, sample)
      } else {
        (current - 1.0, self.prev)
      };
      while self.next_pos <= current {
        let t = (self.next_pos - base_pos).clamp(0.0, 1.0);
        let value = base_val + t as f32 * (sample - base_val);
        // El FIR puede sobrepasar ligeramente por ringing de Gibbs; el
        // contrato hacia el modelo es [-1.0, 1.0].
        out.push(value.clamp(-PEAK, PEAK));
        self.next_pos += self.step;
      }
      self.prev = sample;
    }
    self.input_pos += input.len() as f64;
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Genera un segundo de senoide a `rate`, en mono.
  fn mono_tone(rate: u32, freq: f32, seconds: f32, amplitude: f32) -> Vec<f32> {
    let frames = (rate as f32 * seconds) as usize;
    (0..frames)
      .map(|i| (std::f64::consts::TAU * freq as f64 * i as f64 / rate as f64).sin() as f32)
      .map(|s| s * amplitude)
      .collect()
  }

  /// Envuelve un vector mono como audio interleado estereo duplicando el canal.
  fn to_stereo(mono: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(mono.len() * 2);
    for &s in mono {
      out.push(s);
      out.push(s);
    }
    out
  }

  /// Frecuencia estimada por cruces de cero (ignora los primeros milisegundos,
  /// donde el FIR anti-alias aun se estabiliza).
  fn estimate_frequency(samples: &[f32], rate: u32) -> f32 {
    let skip = (rate as f32 * 0.05) as usize;
    let mut crossings = 0usize;
    for pair in samples[skip..].windows(2) {
      if pair[0] <= 0.0 && pair[1] > 0.0 {
        crossings += 1;
      }
    }
    crossings as f32 * rate as f32 / (samples.len() - skip) as f32
  }

  fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()))
  }

  /// Pico en regimen permanente, saltandose los primeros `skip` segundos.
  ///
  /// El arranque de una senal que empieza en seco excita la respuesta al escalon del
  /// FIR, y ese transitorio es mas alto que la propia senal filtrada: medirlo como si
  /// fuera la atenuacion daria un falso negativo (o positivo) segun cuantos taps tenga
  /// el filtro.
  fn peak_settled(samples: &[f32], rate: u32) -> f32 {
    let skip = (rate as f32 * 0.1) as usize;
    peak(&samples[skip.min(samples.len())..])
  }

  /// Objetivo principal del sprint: 48 kHz estereo -> 16 kHz mono exacto.
  #[test]
  fn remuestrea_48k_estereo_a_16k_mono() {
    let tone = mono_tone(48_000, 1_000.0, 1.0, 0.5);
    let stereo = to_stereo(&tone);
    assert_eq!(stereo.len(), 96_000);

    let mut resampler = Resampler::new(48_000);
    let mut out = Vec::new();
    resampler.process_interleaved(&stereo, 2, &mut out);

    assert_eq!(
      out.len(),
      16_000,
      "1 s de audio a 48 kHz debe producir exactamente 16 000 muestras"
    );
    assert!(out.iter().all(|s| s.is_finite()), "salida con NaN/Inf");
    assert!(
      out.iter().all(|s| (-1.0..=1.0).contains(s)),
      "las amplitudes deben permanecer en [-1.0, 1.0]"
    );
    assert!(
      (peak(&out) - 0.5).abs() < 0.02,
      "la amplitud de un tono puro debe conservarse, peak={}",
      peak(&out)
    );
  }

  /// El tono debe seguir a 1 kHz: si la relacion de remuestreo fuera erronea,
  /// la frecuencia de salida se desplazaria proporcionalmente.
  #[test]
  fn conserva_la_frecuencia_del_tono() {
    let tone = mono_tone(48_000, 1_000.0, 1.0, 0.5);
    let mut resampler = Resampler::new(48_000);
    let mut out = Vec::new();
    resampler.process_mono(&tone, &mut out);

    let freq = estimate_frequency(&out, resampler.output_rate());
    assert!(
      (freq - 1_000.0).abs() < 20.0,
      "frecuencia de salida inesperada: {freq} Hz"
    );
  }

  /// 44,1 kHz es la otra tasa habitual de las tarjetas de sonido.
  #[test]
  fn remuestrea_44100_a_16k() {
    let tone = mono_tone(44_100, 1_000.0, 1.0, 0.5);
    let mut resampler = Resampler::new(44_100);
    let mut out = Vec::new();
    resampler.process_mono(&tone, &mut out);

    // 44100/16000 = 2.75625 muestras de entrada por muestra de salida.
    let expected = tone.len() as f64 / (44_100.0 / 16_000.0);
    assert!(
      (out.len() as f64 - expected).abs() <= 1.0,
      "se esperaban ~{expected} muestras, se obtuvieron {}",
      out.len()
    );
    let freq = estimate_frequency(&out, 16_000);
    assert!(
      (freq - 1_000.0).abs() < 25.0,
      "frecuencia de salida inesperada: {freq} Hz"
    );
  }

  /// Sin remuestreo solo debe hacer downmix (micro nativo a 16 kHz).
  #[test]
  fn downmix_sin_cambio_de_tasa() {
    let mut resampler = Resampler::new(16_000);
    let mut out = Vec::new();
    resampler.process_interleaved(&[1.0, 0.0, -1.0, 1.0], 2, &mut out);
    assert_eq!(out, vec![0.5, 0.0]);
  }

  /// El caso de uso real: WASAPI entrega bloques de ~10 ms. Procesar bloque a
  /// bloque tiene que dar el mismo resultado que procesar el flujo entero; un
  /// remuestrador sin estado fallaria aqui con clicks en las fronteras.
  #[test]
  fn es_estable_entre_bloques() {
    let tone = mono_tone(48_000, 1_000.0, 1.0, 0.5);
    let stereo = to_stereo(&tone);

    let mut one_shot = Resampler::new(48_000);
    let mut reference = Vec::new();
    one_shot.process_interleaved(&stereo, 2, &mut reference);

    let mut chunked = Resampler::new(48_000);
    let mut out = Vec::new();
    for block in stereo.chunks(960) {
      chunked.process_interleaved(block, 2, &mut out);
    }

    assert_eq!(
      out.len(),
      reference.len(),
      "el numero de muestras no debe depender del tamano de bloque"
    );
    let max_diff = out
      .iter()
      .zip(reference.iter())
      .map(|(a, b)| (a - b).abs())
      .fold(0.0f32, f32::max);
    assert!(
      max_diff < 1e-6,
      "el remuestreo por bloques difiere del continuo: {max_diff}"
    );
  }

  /// A 48 kHz, un tono de 12 kHz cae por encima del Nyquist de la salida (8 kHz).
  /// Sin filtro anti-alias se devolveria con amplitud completa, aliasing a 4 kHz.
  #[test]
  fn filtra_el_aliasing_al_decimar() {
    // Dos remuestreadores independientes: si se reutilizara el mismo, la historia del
    // FIR y la fase arrastradas del primer tono contaminarian la medida del segundo.
    let in_band = mono_tone(48_000, 1_000.0, 1.0, 0.5);
    let out_of_band = mono_tone(48_000, 12_000.0, 1.0, 0.5);

    let mut pasabanda = Resampler::new(48_000);
    let mut kept = Vec::new();
    pasabanda.process_mono(&in_band, &mut kept);

    let mut fuera_de_banda = Resampler::new(48_000);
    let mut aliased = Vec::new();
    fuera_de_banda.process_mono(&out_of_band, &mut aliased);

    let kept_peak = peak_settled(&kept, 16_000);
    let rejected_peak = peak_settled(&aliased, 16_000);
    assert!(kept_peak > 0.4, "la banda pasabanda debe pasar intacta");
    assert!(
      rejected_peak < kept_peak * 0.1,
      "el tono de 12 kHz deberia atenuarse (12 kHz: {rejected_peak} vs 1 kHz: {kept_peak})"
    );
  }

  /// Subir de 8 kHz a 16 kHz no necesita filtro, solo interpolacion.
  #[test]
  fn remuestrea_hacia_arriba_sin_filtro() {
    let tone = mono_tone(8_000, 500.0, 1.0, 0.5);
    let mut resampler = Resampler::new(8_000);
    assert!(resampler.low_pass.is_none());
    let mut out = Vec::new();
    resampler.process_mono(&tone, &mut out);
    // 1 s a 16 kHz son 16 000 muestras. Se admite una menos: la ultima posicion de
    // salida cae a mitad de camino entre las dos ultimas muestras de entrada, y un
    // interpolador causal no puede emitirla sin conocer la muestra siguiente.
    assert!(
      (out.len() as i64 - 16_000).abs() <= 1,
      "se esperaban ~16 000 muestras, se obtuvieron {}",
      out.len()
    );
    let freq = estimate_frequency(&out, 16_000);
    assert!((freq - 500.0).abs() < 15.0, "frecuencia inesperada: {freq}");
  }

  /// Entradas degeneradas: no deben panicar ni producir audio invalido.
  #[test]
  fn tolera_entradas_degeneradas() {
    let mut resampler = Resampler::new(48_000);
    let mut out = Vec::new();
    resampler.process_interleaved(&[], 2, &mut out);
    assert!(out.is_empty());

    // Trama incompleta: se descarta en lugar de desalinear los canales.
    resampler.process_interleaved(&[0.1, 0.2, 0.3], 2, &mut out);
    assert_eq!(out.len(), 1, "una trama completa de un bloque a medias");

    // Tasa de entrada 0 se sanea a 1 en lugar de dividir por cero.
    let saneado = Resampler::with_rates(0, 0);
    assert_eq!(saneado.input_rate(), 1);
    assert_eq!(saneado.output_rate(), 1);
  }

  /// Satura a [-1, 1] incluso con entradas fuera de rango (FFT, ganancia, etc.).
  #[test]
  fn limita_las_amplitudes() {
    let mut resampler = Resampler::new(48_000);
    let mut out = Vec::new();
    resampler.process_mono(&[8.0; 4_800], &mut out);
    assert!(out.iter().all(|s| (-1.0..=1.0).contains(s)));
  }

  /// La latencia del FIR debe ser despreciable para el reconocedor de voz.
  #[test]
  fn la_latencia_es_despreciable() {
    let resampler = Resampler::new(48_000);
    assert!(resampler.latency() <= 64, "latencia alta para STT");
  }

  /// El FIR arranca con la historia a cero, asi que los primeros samples salen
  /// atenuados hasta que se llena. Lo que no puede pasar es que la cadena se quede
  /// corta o desfasada: con un tono constante, la salida debe estabilizarse en la
  /// amplitud de entrada y con el numero de muestras exacto.
  #[test]
  fn el_fir_se_asienta_sin_perder_muestras() {
    // 4 800 muestras de 48 kHz = 1 600 de 16 kHz.
    let input = vec![0.8f32; 4_800];
    let mut resampler = Resampler::new(48_000);
    let mut out = Vec::new();
    resampler.process_mono(&input, &mut out);

    assert_eq!(out.len(), 1_600, "no se deben perder ni anadir muestras");
    let tail = &out[1_400..];
    let settled = peak(tail);
    assert!(
      (settled - 0.8).abs() < 0.02,
      "un tono constante deberia asentarse en 0,8, se obtuvo {settled}"
    );
    assert!(
      out[0].abs() < 0.1,
      "el arranque del filtro no debe colarse en la senal: {}",
      out[0]
    );
  }
}
