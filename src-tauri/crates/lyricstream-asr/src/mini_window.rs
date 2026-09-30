//! Mini-ventana: geometria del modo compacto.
//!
//! # Por que esto vive aqui y no en el crate de Tauri
//!
//! Porque el crate raiz tiene `test = false`: su enlazador no puede arrancar el harness
//! de un binario que enlace Tauri, asi que ahi no se puede escribir ni un test, y una
//! regla de negocio sin test no es una regla, es una costumbre. Este modulo es la
//! regla que decide como se pasa de una ventana a la otra y como se vuelve, y se
//! ejercita entera sin ventana, sin pantalla y sin whisper.
//!
//! # Que hay aqui y que hay en el comando
//!
//! Aqui, solo aritmetica y deciciones: convertir entre pixeles fisicos y logicos, limitar
//! el tamano a la pantalla, recordar la geometria anterior y decidir si cabe pegada a una
//! esquina. En el comando, solo las llamadas a la ventana. Esa separacion es la que
//! permite que lo que se puede equivocar se pruebe.
//!
//! # Por que la geometria se guarda en pixeles FISICOS
//!
//! Windows entrega tamanos en pixeles fisicos, y un portatil con escala 150 % tiene
//! ventanas de 1500x1050 fisicos para el mismo 1000x700 logico. Guardar el size que
//! devuelve la API y restaurarlo tal cual evita el error clasico derestaurar un valor ya
//! escalado por la API, que deja la ventana un 50 % mas grande de lo que era.

/// Ancho y alto logicos de la mini-ventana.
///
/// 450x250 cabe en una pantalla de 1366x768 con la barra de tareas puesta, que es el
/// caso mas estrecho de un portatil que todavia se usa. Con `minWidth: 800` en
/// `tauri.conf.json` habria que bajar ese minimo al activar el modo, o Windows no
/// dejaria encojer la ventana: por eso el comando usa `set_min_size(None)`.
pub const MINI_ANCHO: f64 = 450.0;
/// Alto del modo compacto. Ver [`MINI_ANCHO`].
pub const MINI_ALTO: f64 = 250.0;

/// Margen respecto al borde de la pantalla, en pixeles fisicos.
///
/// No es cero a proposito: una ventana pegada al borde exacto de la pantalla es casi
/// imposible de redimensionar con el raton, porque el borde coincide con el borde de la
/// pantalla. Con margen, la esquina queda agarrable.
pub const MARGEN_PANTALLA: i32 = 16;

/// Geometria de la ventana principal, recordada al entrar en modo mini.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometria {
  pub x: i32,
  pub y: i32,
  /// Ancho, en pixeles fisicos.
  pub w: u32,
  /// Alto, en pixeles fisicos.
  pub h: u32,
}

impl Geometria {
  /// Crea una geometria en el origen.
  pub fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
    Self { x, y, w, h }
  }
}

/// Pantalla donde se coloca la mini-ventana, en pixeles fisicos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pantalla {
  pub x: i32,
  pub y: i32,
  pub w: u32,
  pub h: u32,
}

impl Pantalla {
  /// Crea un rectangulo de pantalla.
  pub fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
    Self { x, y, w, h }
  }
}

/// Convierte un tamano logico a fisico con la escala del monitor.
///
/// Windows en un monitor con escala 125 % recibe de `set_size` un valor que la API
/// multiplica por la escala. El inverso, `fisico / escala`, es lo que hay que aplicar a
/// un tamano que la API ya devolvio escalado antes de volver a pasarselo.
///
/// Una escala de 0 o negativa daria una division por cero o un tamaño sin sentido. La
/// escala la fija el SO y nunca es 0, pero el fallback a 1.0 deja el resultado ser
/// correcto en vez de entrar en panic en el camino de recuperacion, que es el peor
/// sitio para un panic.
pub fn a_fisico(logico: f64, escala: f64) -> u32 {
  let escala = if escala.is_finite() && escala > 0.0 {
    escala
  } else {
    1.0
  };
  let px = (logico * escala).round();
  if px <= 0.0 {
    0
  } else {
    px as u32
  }
}

/// Convierte un tamano fisico a logico con la escala del monitor. Inverso de [`a_fisico`].
pub fn a_logico(fisico: u32, escala: f64) -> f64 {
  let escala = if escala.is_finite() && escala > 0.0 {
    escala
  } else {
    1.0
  };
  fisico as f64 / escala
}

/// Limita un tamano al de la pantalla.
///
/// Sin esto, entrar en modo mini en una pantalla mas pequena que 450x250 deja la ventana
/// mas grande que la pantalla, con la barra de tareas por encima y sin forma de bajarla a
/// mano porque el borde inferior queda fuera. El ancho y el alto se ajustan por separado
/// para que una pantalla panoramica no se recorte en alto ni al reves.
pub fn limitar_a_pantalla(ancho: u32, alto: u32, pantalla: Pantalla) -> (u32, u32) {
  (ancho.min(pantalla.w), alto.min(pantalla.h))
}

/// Coloca la mini-ventana pegada a la esquina inferior derecha de la pantalla.
///
/// Abajo a la derecha y no centrado porque es donde se mira: la esquina opuesta a la
/// ventana principal es la que no se tapa, y el reloj del sistema esta ahi. En una
/// pantalla tactil, abajo a la derecha es ademas donde cae el pulgar.
pub fn esquina_inferior_derecha(ancho: u32, alto: u32, pantalla: Pantalla) -> Geometria {
  // El margen nunca puede empujar la ventana FUERA de la pantalla. Con una ventana mas
  // grande que la pantalla, `saturating_sub` deja el hueco en 0 y, si el margen se
  // restara igual, la posicion saldria negativa: en Windows eso coloca la ventana en el
  // monitor de la izquierda, que es donde aparece en serio cuando la mini se activa en
  // una pantalla pequena. El `max` con el origen de la pantalla es lo que lo evita.
  let margen = MARGEN_PANTALLA
    .min(pantalla.w as i32 / 4)
    .min(pantalla.h as i32 / 4);
  // `saturating_sub` y no `as i32` sobre el `u32`: un ancho mayor que la pantalla
  // daria un negativo al restar, y una posicion negativa en Windows coloca la ventana
  // en el monitor de la izquierda.
  let hueco_x = (pantalla.w as i32).saturating_sub(ancho as i32);
  let hueco_y = (pantalla.h as i32).saturating_sub(alto as i32);
  let x = pantalla.x + (hueco_x - margen).max(0);
  let y = pantalla.y + (hueco_y - margen).max(0);
  Geometria::new(x, y, ancho, alto)
}

/// Decide la geometria de la mini-ventana.
///
/// `escala` es la del monitor, y se aplica aqui y no en el comando para que el redondeo
/// sea comprobable: el comando pasa pixeles logicos y esta funcion decide, en un solo
/// sitio, que se manda a la API.
pub fn plan_mini(escala: f64, pantalla: Pantalla) -> Geometria {
  let ancho = a_fisico(MINI_ANCHO, escala);
  let alto = a_fisico(MINI_ALTO, escala);
  let (ancho, alto) = limitar_a_pantalla(ancho, alto, pantalla);
  esquina_inferior_derecha(ancho, alto, pantalla)
}

/// Estado de la ventana entre el modo normal y el mini.
///
/// Guarda la geometria anterior para poder volver, y el estado de decorations y
/// always-on-top para que restaurarlos sea exacto y no "lo que creamos que tenian".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MiniEstado {
  /// `true` si la ventana esta en modo compacto ahora mismo.
  pub activo: bool,
  /// Geometria a la que volver. `None` hasta que se entra en modo mini.
  pub restaurable: Option<Geometria>,
}

impl Default for MiniEstado {
  fn default() -> Self {
    Self {
      activo: false,
      restaurable: None,
    }
  }
}

impl MiniEstado {
  /// Estado inicial: ventana normal, sin nada que restaurar.
  pub fn new() -> Self {
    Self::default()
  }

  /// Vuelve al estado inicial.
  pub fn reset(&mut self) {
    *self = Self::default();
  }

  /// Entra en modo mini, recordando donde estaba la ventana.
  ///
  /// Devuelve `false` si ya estaba en modo mini. Es idempente a proposito: el boton y el
  /// atajo pueden llegar a la vez, y un doble `set_size` con la misma pantalla no hacia
  /// falta. La geometria se recuerda **antes** de cambiar nada, que es el orden en el que
  /// se puede leer la ventana real todavia.
  pub fn entrar(&mut self, actual: Geometria) -> bool {
    if self.activo {
      return false;
    }
    self.restaurable = Some(actual);
    self.activo = true;
    true
  }

  /// Sale del modo mini y devuelve la geometria a la que hay que volver.
  ///
  /// Devuelve `None` si no estaba en modo mini, o si se entra en modo mini sin haber
  /// guardado geometria (un `reset` por un error previo). En ese caso el comando no toca
  /// el tamano en vez de inventar uno.
  pub fn salir(&mut self) -> Option<Geometria> {
    if !self.activo {
      return None;
    }
    self.activo = false;
    let previo = self.restaurable.take();
    previo
  }

  /// Alterna el modo y devuelve la geometria que hay que aplicar.
  ///
  /// Es la funcion que llama el comando, y devuelve tambien si hay que redimensionar:
  /// salir del modo mini sin geometria guardada no debe tocar el tamano.
  pub fn alternar(&mut self, actual: Geometria, escala: f64, pantalla: Pantalla) -> Decision {
    if self.activo {
      return match self.salir() {
        Some(geom) => Decision::Restaurar(geom),
        // Sin geometria guardada, el estado sigue siendo "normal" pero el comando no
        // redimensiona. Antes esto devolvia la geometria por defecto, que se comia la
        // ventana del usuario sin avisar.
        None => Decision::SoloEstado,
      };
    }
    self.entrar(actual);
    Decision::Mini(plan_mini(escala, pantalla))
  }
}

/// Que hay que hacer con la ventana tras alternar el modo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
  /// Ponerla en modo compacto, con esta geometria.
  Mini(Geometria),
  /// Volver a la geometria anterior.
  Restaurar(Geometria),
  /// Solo corregir el estado: el tamano se deja como esta.
  SoloEstado,
}

impl Decision {
  /// La geometria a aplicar, si hay alguna.
  pub fn geometria(self) -> Option<Geometria> {
    match self {
      Decision::Mini(g) | Decision::Restaurar(g) => Some(g),
      Decision::SoloEstado => None,
    }
  }

  /// `true` si la ventana queda en modo compacto.
  pub fn mini(self) -> bool {
    matches!(self, Decision::Mini(_))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const PANTALLA: Pantalla = Pantalla {
    x: 0,
    y: 0,
    w: 1920,
    h: 1080,
  };

  #[test]
  fn escala_1_deja_el_tamano_logico_igual() {
    assert_eq!(a_fisico(450.0, 1.0), 450);
    assert_eq!(a_fisico(250.0, 1.0), 250);
  }

  #[test]
  fn escala_alta_multiplica_el_tamano_logico() {
    // 125 %: 450 logicos son 562,5 fisicos, que redondea a 563.
    assert_eq!(a_fisico(450.0, 1.25), 563);
    assert_eq!(a_fisico(250.0, 1.25), 313);
  }

  #[test]
  fn escala_de_150_por_ciento_va_y_vuelve() {
    // El ciclo completo es lo que importa: si `a_fisico` y `a_logico` no son inversos,
    // al entrar y salir del modo mini la ventana crece o se encoge en cada ciclo.
    for escala in [1.0, 1.25, 1.5, 2.0, 3.0] {
      for logico in [MINI_ANCHO, MINI_ALTO] {
        let fisico = a_fisico(logico, escala);
        let vuelta = a_logico(fisico, escala);
        assert!(
          (vuelta - logico).abs() < 1.0,
          "escala {escala}: {logico} -> {fisico} -> {vuelta}"
        );
      }
    }
  }

  #[test]
  fn escala_invalida_no_entra_en_panic() {
    // El camino de recuperacion es el peor sitio para un panic, y una escala de 0 lo
    // provocaria con una division por cero.
    assert_eq!(a_fisico(450.0, 0.0), 450);
    assert_eq!(a_fisico(450.0, -1.0), 450);
    assert_eq!(a_fisico(450.0, f64::NAN), 450);
    assert_eq!(a_logico(450, f64::NAN), 450.0);
  }

  #[test]
  fn un_tamano_negativo_no_se_convierte_en_una_ventana_enorme() {
    // `as u32` sobre un flotante negativo en Rust da 0, pero el casteo desde `f64` a
    // `u32` esta saturado: lo que hay que comprobar es que no da un numero gigante.
    assert!(a_fisico(-100.0, 1.0) < 10);
  }

  #[test]
  fn la_mini_se_limita_a_una_pantalla_pequena() {
    // Sin limitar, 450x250 en una pantalla de 320x240 deja la ventana por encima de la
    // pantalla, con la barra de tareas por delante y sin borde agarrable.
    let (ancho, alto) = limitar_a_pantalla(563, 313, Pantalla::new(0, 0, 320, 240));
    assert_eq!((ancho, alto), (320, 240));
  }

  #[test]
  fn la_mini_no_crece_una_pantalla_grande() {
    assert_eq!(limitar_a_pantalla(563, 313, PANTALLA), (563, 313));
  }

  #[test]
  fn la_mini_queda_pegada_a_la_esquina_inferior_derecha() {
    let g = esquina_inferior_derecha(450, 250, PANTALLA);
    // El cast explicito por lado: la geometria mezcla `i32` para la posicion (puede ser
    // negativa en un monitor a la izquierda) y `u32` para el tamano, que en Windows es
    // `u32` de verdad. Sumarlos sin castear no compila, que es la version barata de que
    // los dos sean del mismo signo.
    let gx = g.x;
    let gy = g.y;
    // Derecha: el borde derecho toca el de la pantalla menos el margen.
    assert_eq!(gx + g.w as i32, PANTALLA.w as i32 - MARGEN_PANTALLA);
    // Abajo, igual.
    assert_eq!(gy + g.h as i32, PANTALLA.h as i32 - MARGEN_PANTALLA);
  }

  #[test]
  fn la_esquina_respeta_el_origen_de_la_pantalla() {
    // Con dos monitores, el de la derecha tiene x = 1920. Sin sumar el origen, la ventana
    // saltaria al monitor de la izquierda.
    let pantalla = Pantalla::new(1920, -200, 1280, 1024);
    let g = esquina_inferior_derecha(450, 250, pantalla);
    assert_eq!(g.x, 1920 + 1280 - 450 - MARGEN_PANTALLA);
    assert_eq!(g.y, -200 + 1024 - 250 - MARGEN_PANTALLA);
  }

  #[test]
  fn una_mini_mas_grande_que_la_pantalla_no_sale_de_la_pantalla() {
    // El borde derecho no puede quedar en negativo: una posicion negativa en Windows
    // coloca la ventana en otro monitor.
    let pantalla = Pantalla::new(0, 0, 200, 150);
    let g = esquina_inferior_derecha(450, 250, pantalla);
    assert!(g.x >= 0, "x negativo: {g:?}");
    assert!(g.y >= 0, "y negativo: {g:?}");
  }

  #[test]
  fn entrar_y_salir_devuelve_la_ventana_onde_estaba() {
    // Este es EL test del modulo: si al alternar dos veces la ventana vuelve a su sitio
    // exacto, el modo mini no destruye la disposicion del usuario.
    let original = Geometria::new(120, 80, 1000, 700);
    let mut estado = MiniEstado::new();

    let entrar = estado.alternar(original, 1.0, PANTALLA);
    assert!(entrar.mini());
    assert_eq!(entrar.geometria().map(|g| (g.w, g.h)), Some((450, 250)));

    let salir = estado.alternar(Geometria::new(0, 0, 450, 250), 1.0, PANTALLA);
    assert!(!salir.mini());
    assert_eq!(salir.geometria(), Some(original));
  }

  #[test]
  fn alternar_tres_veces_es_estable() {
    let original = Geometria::new(120, 80, 1000, 700);
    let mut estado = MiniEstado::new();
    for _ in 0..3 {
      estado.alternar(original, 1.0, PANTALLA);
      let salida = estado.alternar(original, 1.0, PANTALLA);
      assert_eq!(salida.geometria(), Some(original));
    }
  }

  #[test]
  fn entrar_dos_veces_no_olvida_la_geometria_original() {
    // El bug que justifica este test: si `entrar` volviera a guardar la geometria
    // MINI como "restaurable", el segundo `salir` devolveria 450x250 y la ventana se
    // quedaria en miniatura para siempre, sin forma de recuperarla.
    let original = Geometria::new(120, 80, 1000, 700);
    let mut estado = MiniEstado::new();
    assert!(estado.entrar(original));
    // Segundo intento: no debe hacer nada.
    assert!(!estado.entrar(Geometria::new(0, 0, 450, 250)));
    assert_eq!(estado.restaurable, Some(original));
  }

  #[test]
  fn salir_sin_entrar_no_toca_nada() {
    // `salir` en vez de `alternar`: con un estado recien creado `alternar` ENTRA, que es
    // lo correcto. Lo que no puede pasar es que un `salir` sin `entrar` devuelva una
    // geometria cualquiera, que luego el comando aplicaria a la ventana del usuario.
    let mut estado = MiniEstado::new();
    assert_eq!(estado.salir(), None);
    assert!(!estado.activo);
  }

  #[test]
  fn alternar_desde_reposo_entra_en_mini() {
    // El caso contrario del anterior, para que los dos queden fijados: el primer clic en
    // el boton tiene que ENCOGER la ventana, no dejarla como estaba.
    let mut estado = MiniEstado::new();
    let d = estado.alternar(Geometria::new(0, 0, 1000, 700), 1.0, PANTALLA);
    assert!(d.mini());
    assert_eq!(d.geometria().map(|g| (g.w, g.h)), Some((450, 250)));
  }

  #[test]
  fn un_reset_no_deja_una_geometria_fantasma() {
    let mut estado = MiniEstado::new();
    estado.entrar(Geometria::new(10, 10, 800, 600));
    estado.reset();
    // Tras un reset, volver a entrar y salir debe devolver la geometria de ESE momento,
    // no la de antes del reset.
    let actual = Geometria::new(1, 2, 640, 480);
    estado.alternar(actual, 1.0, PANTALLA);
    assert_eq!(
      estado.alternar(actual, 1.0, PANTALLA).geometria(),
      Some(actual)
    );
  }

  #[test]
  fn la_escala_alta_no_hace_la_mini_menor_que_la_normal() {
    // A 200 %, 450x250 logicos son 900x500 fisicos, y la ventana normal de 1000x700
    // logicos son 2000x1400 fisicos. La mini tiene que ser MENOR en fisicos, o el
    // modo compacto no compacta nada.
    let mut estado = MiniEstado::new();
    let normal = Geometria::new(0, 0, a_fisico(1000.0, 2.0), a_fisico(700.0, 2.0));
    let decision = estado.alternar(normal, 2.0, Pantalla::new(0, 0, 3840, 2160));
    let mini = decision.geometria().unwrap();
    assert!(
      mini.w < normal.w,
      "mini {mini:?} no es menor que {normal:?}"
    );
    assert!(
      mini.h < normal.h,
      "mini {mini:?} no es menor que {normal:?}"
    );
  }
}
