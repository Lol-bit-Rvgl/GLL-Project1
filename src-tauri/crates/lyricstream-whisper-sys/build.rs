//! Compila UNICAMENTE `csrc/shim.c`.
//!
//! Este es el punto clave del diseno. Compilar whisper.cpp entero (ggml.c son
//! ~40 000 lineas, mas quantizacion, backends y Vulkan) con GCC a `-O3` lleva
//! cientos de MB por unidad de traduccion; en una maquina con ~1 GB libres eso
//! mata el enlazador, o tarda media hora. Aqui no se compila nada de eso: el
//! shim son ~400 lineas que solo necesitan las CABECERAS de whisper, y el codigo
//! real llega en tiempo de ejecucion desde las DLL del release oficial.
//!
//! Resultado: el build sigue siendo de segundos y el binario no depende de
//! whisper en tiempo de compilacion.

use std::path::Path;

fn main() {
  let csrc = Path::new("csrc");
  let vendor = Path::new("vendor/whisper");

  println!("cargo:rerun-if-changed={}", csrc.join("shim.c").display());
  for header in [
    "whisper.h",
    "ggml.h",
    "ggml-cpu.h",
    "ggml-backend.h",
    "ggml-alloc.h",
  ] {
    println!("cargo:rerun-if-changed={}", vendor.join(header).display());
  }
  println!("cargo:rerun-if-changed=build.rs");

  let mut build = cc::Build::new();
  build
    .file(csrc.join("shim.c"))
    .include(vendor)
    // No hay codigo de whisper aqui, solo cabeceras: no hace falta optimization
    // agresiva ni -mavx2, y sin ellas el shim compila en cualquier x86-64.
    .opt_level(2)
    .warnings(true)
    // El shim usa LoadLibrary, que en Windows exige <windows.h>. MinGW lo trae.
    .define("WIN32_LEAN_AND_MEAN", None);

  // En Windows el `cc` de MinGW produce una biblioteca estatica que se enlaza en el
  // rlib; no se necesita link dinamico contra whisper porque todo se resuelve en
  // ejecucion con GetProcAddress.
  build.compile("lyricstream_whisper_shim");

  // El enlace contra las funciones de Windows (LoadLibraryExW, GetProcAddress,
  // MultiByteToWideChar) es explicito: el crate no depende de kernel32 en el
  // Cargo.toml porque no lo necesita en ningun otro sitio, y colgar la dependencia
  // solo por el shim seria mas ruido que valor.
  if cfg!(target_os = "windows") {
    println!("cargo:rustc-link-lib=dylib=kernel32");
  }
}
