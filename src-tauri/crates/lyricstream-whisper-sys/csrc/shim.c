/*
 * Puente C minimo sobre la API C de whisper.cpp.
 *
 * ============================ POR QUE EXISTE ESTE FICHERO ============================
 *
 * `struct whisper_full_params` tiene ~60 campos, estructuras anidadas (greedy,
 * beam_search), punteros a funcion y punteros `const char *`. Declarar esa
 * estructura a mano en Rust con `#[repr(C)]` es una trampa de ABI: si un solo
 * campo queda en orden equivocado, o un `bool` de C (1 byte) se alinea a 4, el
 * resultado no es un error de compilacion sino texto basura o un crash en tiempo
 * de ejecucion, y solo se detecta compilando contra la version exacta.
 *
 * Aqui el COMPILADOR C es el dueno del layout. Rust nunca ve `whisper_full_params`:
 * ve unas pocas funciones planas cuya firma no depende de la estructura interna de
 * whisper y que, por tanto, no se rompen al actualizar whisper.
 *
 * ============================ POR QUE CARGA DINAMICA ============================
 *
 * El zip oficial (whisper-bin-x64.zip) no trae bibliotecas de importacion (.lib),
 * solo las DLL: no hay nada contra lo que enlazar en tiempo de compilacion. Y
 * conviene por otra razon: si el runtime no esta desplegado, la app debe arrancar y
 * explicar que falta, no negarse a arrancar. De ahi `LoadLibraryExW` con
 * `LOAD_WITH_ALTERED_SEARCH_PATH`, que hace que las dependencias de whisper.dll
 * (ggml.dll, ggml-cpu-*.dll) se busquen junto a ella y no en el PATH del proceso.
 *
 * Las DLL oficiales son MSVC y el ejecutable es MinGW. El enlace es solo de
 * interfaz C (mismo ABI, sin decoraciones de nombre), asi que no hace falta MSVC.
 *
 * ============================ VERSION ============================
 *
 * Las cabeceras de `vendor/whisper/` estan fijadas al commit `b5130`, el mismo
 * build que produjo las DLL del release. whisper.cpp no expone macro de version en
 * la cabecera, asi que el tag se declara aqui. Al actualizar las DLL hay que
 * actualizar tambien las cabeceras y LRS_WHISPER_BUILD.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <wchar.h>

#include "whisper.h"

#ifdef _WIN32
#  define LRS_API __declspec(dllexport)
#  include <windows.h>
#else
#  define LRS_API __attribute__((visibility("default")))
#  include <dlfcn.h>
#endif

/* Commit de whisper.cpp con el que se compilo este shim. */
#define LRS_WHISPER_BUILD "b5130"

/* Codigos de error de lrs_whisper_load. */
#define LRS_LOAD_OK             0
#define LRS_LOAD_ERR_NO_DIR    -2
#define LRS_LOAD_ERR_DLL       -3
#define LRS_LOAD_ERR_SYMBOL    -4

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------ */
/* Resolucion de simbolos                                              */
/* ------------------------------------------------------------------ */

#ifdef _WIN32
typedef HMODULE lrs_lib;
static lrs_lib lrs_open(const wchar_t * path) {
    return LoadLibraryExW(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
}
static void * lrs_sym(lrs_lib h, const char * name) {
    return (void *) GetProcAddress(h, name);
}
static void lrs_close(lrs_lib h) { FreeLibrary(h); }
#else
typedef void * lrs_lib;
static lrs_lib lrs_open(const char * path) { return dlopen(path, RTLD_NOW | RTLD_LOCAL); }
static void * lrs_sym(lrs_lib h, const char * name) { return dlsym(h, name); }
static void lrs_close(lrs_lib h) { dlclose(h); }
#endif

/* ------------------------------------------------------------------ */
/* Tabla de funciones y estado global                                   */
/* ------------------------------------------------------------------ */

typedef struct whisper_context *(*fn_init_file)   (const char *, struct whisper_context_params);
typedef struct whisper_state  *(*fn_init_state)  (struct whisper_context *);
typedef void                   (*fn_free_state)  (struct whisper_state *);
typedef void                   (*fn_free)        (struct whisper_context *);
typedef int  (*fn_full_with_state) (struct whisper_context *, struct whisper_state *,
                                    struct whisper_full_params, const float *, int);
/* OJO: en whisper.cpp actual `*_default_params` devuelven la estructura POR VALOR,
   no por puntero. Hay funciones `*_by_ref` aparte para eso. */
typedef struct whisper_full_params (*fn_default_params) (enum whisper_sampling_strategy);
typedef struct whisper_context_params (*fn_ctx_default_params) (void);
typedef int      (*fn_n_segments)   (struct whisper_state *);
typedef const char *(*fn_seg_text)   (struct whisper_state *, int);
typedef int64_t (*fn_seg_t0)        (struct whisper_state *, int);
typedef int64_t (*fn_seg_t1)        (struct whisper_state *, int);
typedef int      (*fn_lang_id)      (struct whisper_context *);
typedef int      (*fn_is_multilingual)(struct whisper_context *);
typedef const char *(*fn_lang_str)   (int);
typedef int      (*fn_lang_id_str)  (const char *);
/* De ggml, no de whisper. Ver el comentario de lrs_register_backends: sin esto no
   existe ningun dispositivo CPU y whisper aborta con GGML_ASSERT(device). */
typedef void     (*fn_load_all_from_path) (const char *);

static struct {
    lrs_lib              lib;
    fn_init_file         init_file;
    fn_init_state        init_state;
    fn_free_state        free_state;
    fn_free              free;
    fn_full_with_state   full_with_state;
    fn_default_params    default_params;
    fn_ctx_default_params ctx_default_params;
    fn_n_segments        n_segments;
    fn_seg_text          seg_text;
    fn_seg_t0            seg_t0;
    fn_seg_t1            seg_t1;
    fn_lang_id           lang_id;
    fn_is_multilingual   is_multilingual;
    fn_lang_str          lang_str;
    fn_lang_id_str       lang_id_str;
    lrs_lib              ggml; /* se mantiene abierto: lo necesita el registro */
    fn_load_all_from_path load_all_from_path;

    int                  n_threads;  /* con el que se inicializo el contexto */
    char                 error[256]; /* ultimo error, para el diagnostico     */
} g;

/* Registra un mensaje de error para que Rust pueda leerlo. */
static void lrs_set_error(const char * msg) {
    snprintf(g.error, sizeof(g.error), "%s", msg ? msg : "error desconocido");
}

/* Cierra la libreria y pone todos los punteros a NULL. */
static void lrs_unload_lib(void) {
    if (g.lib) {
        lrs_close(g.lib);
        g.lib = NULL;
    }
    if (g.ggml) {
        lrs_close(g.ggml);
        g.ggml = NULL;
    }
    memset(&g.init_file, 0, sizeof(g.init_file));
    g.n_threads = 0;
}

/*
 * Registra los backends de ggml que haya en el directorio `dir`.
 *
 * ESTE PASO NO ES OPCIONAL, y es la razon de que el shim exista.
 *
 * En whisper.cpp actual el backend de CPU no esta dentro de whisper.dll, sino en su
 * propia DLL (`ggml-cpu-alderlake.dll`, una por variante de CPU). El registro de
 * backends de ggml la busca y la carga, pero SOLO cuando se llama a
 * `ggml_backend_load_all()`. Ni `whisper_init_from_file_with_params` ni
 * `whisper_init_state` lo llaman jamas: es responsabilidad de quien usa la libreria.
 *
 * Todos los binarios de whisper.cpp (cli, bench, server, stream...) llaman a
 * `ggml_backend_load_all()` al empezar. Si el shim no lo hace, el modelo se carga
 * bien y luego la inicializacion del estado revienta con
 *
 *   ggml-backend.cpp: GGML_ASSERT(device) failed
 *
 * en `ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU)`, que devuelve NULL
 * porque no hay ningun backend registrado. Es un fallo de ejecucion, no una excepcion:
 * el proceso muere con STATUS_STACK_BUFFER_OVERRUN.
 *
 * Se pasa `dir` y no NULL para que busque las `ggml-*.dll` junto al runtime, y no en
 * el directorio del ejecutable, que en una app Tauri es otro distinto.
 */
static void lrs_register_backends(const char * dir) {
    if (g.load_all_from_path) {
        g.load_all_from_path(dir);
    }
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

/*
 * Carga whisper.dll desde el directorio `dir`. Idempotente.
 * Devuelve LRS_LOAD_OK o un codigo negativo (ver defines de arriba).
 */
LRS_API int lrs_whisper_load(const char * dir) {
    if (g.lib) {
        return LRS_LOAD_OK;
    }
    if (!dir || !dir[0]) {
        return LRS_LOAD_ERR_NO_DIR;
    }
    memset(&g, 0, sizeof(g));

#ifdef _WIN32
    wchar_t wpath[MAX_PATH];
    const int n = MultiByteToWideChar(CP_UTF8, 0, dir, -1, wpath, MAX_PATH);
    if (n <= 0) {
        lrs_set_error("ruta no convertible a UTF-16");
        return LRS_LOAD_ERR_DLL;
    }
    if ((size_t) n + 16 >= MAX_PATH) {
        lrs_set_error("la ruta del runtime es demasiado larga");
        return LRS_LOAD_ERR_NO_DIR;
    }
    wcscat(wpath, L"\\whisper.dll");
    lrs_lib h = lrs_open(wpath);
    if (!h) {
        /* Se reintenta sin forzar el directorio de busqueda. Con
           LOAD_WITH_ALTERED_SEARCH_PATH ya deberia bastar, pero si el usuario tiene
           whisper.dll en el PATH del sistema este camino tambien funciona. */
        h = LoadLibraryExW(L"whisper.dll", NULL, 0);
    }
#else
    char cpath[4096];
    snprintf(cpath, sizeof(cpath), "%s/libwhisper.so", dir);
    lrs_lib h = lrs_open(cpath);
#endif
    if (!h) {
        lrs_set_error("no se encontro whisper.dll (o libwhisper.so) en el directorio");
        return LRS_LOAD_ERR_DLL;
    }

    /* Cada simbolo es obligatorio. Dejar uno a medias produce un puntero nulo que
       solo reventaria mas tarde, dentro de una inferencia, con el usuario
       esperando. Aqui se falla al arrancar, que es cuando el diagnostico sirve. */
#define LRS_SYM(field, name)                                          \
    do {                                                              \
        *(void **) (&g.field) = lrs_sym(h, name);                     \
        if (!g.field) {                                               \
            lrs_set_error("falta el simbolo " name " en la libreria"); \
            lrs_close(h);                                             \
            return LRS_LOAD_ERR_SYMBOL;                               \
        }                                                             \
    } while (0)

    LRS_SYM(init_file,         "whisper_init_from_file_with_params");
    LRS_SYM(init_state,        "whisper_init_state");
    LRS_SYM(free_state,        "whisper_free_state");
    LRS_SYM(free,              "whisper_free");
    LRS_SYM(full_with_state,   "whisper_full_with_state");
    LRS_SYM(default_params,    "whisper_full_default_params");
    LRS_SYM(ctx_default_params,"whisper_context_default_params");
    LRS_SYM(n_segments,        "whisper_full_n_segments_from_state");
    LRS_SYM(seg_text,          "whisper_full_get_segment_text_from_state");
    LRS_SYM(seg_t0,            "whisper_full_get_segment_t0_from_state");
    LRS_SYM(seg_t1,            "whisper_full_get_segment_t1_from_state");
    LRS_SYM(lang_id,           "whisper_full_lang_id");
    LRS_SYM(is_multilingual,   "whisper_is_multilingual");
    LRS_SYM(lang_str,          "whisper_lang_str");
    LRS_SYM(lang_id_str,       "whisper_lang_id");
#undef LRS_SYM

    g.lib = h;

    /*
     * `ggml_backend_load_all_from_path` lo exporta ggml.dll, no whisper.dll. En un
     * ejecutable normal, whisper-cli.exe enlaza contra ggml y lo tiene en la tabla de
     * importaciones, asi que basta con llamar al simbolo. Aqui no hay enlace: hay que
     * abrir ggml.dll a mano. Como whisper.dll ya la cargo como dependencia, este
     * LoadLibraryEx devuelve el mismo modulo ya mapeado y solo sube el contador de
     * referencias; el unload lo equilibra.
     */
#ifdef _WIN32
    {
        /* `wpath` contiene "<dir>\whisper.dll". Se copia y se cambia el nombre de
           fichero, sin construir la ruta desde cero otra vez. */
        wchar_t wggml[MAX_PATH];
        wcsncpy(wggml, wpath, MAX_PATH - 1);
        wggml[MAX_PATH - 1] = L'\0';
        wchar_t * last = wcsrchr(wggml, L'\\');
        if (!last) {
            lrs_set_error("ruta del runtime sin separador");
            lrs_unload_lib();
            return LRS_LOAD_ERR_NO_DIR;
        }
        wcscpy(last + 1, L"ggml.dll");
        g.ggml = lrs_open(wggml);
    }
    if (g.ggml) {
        g.load_all_from_path =
            (fn_load_all_from_path) lrs_sym(g.ggml, "ggml_backend_load_all_from_path");
    }
#else
    {
        char gpath[4096];
        snprintf(gpath, sizeof(gpath), "%s/libggml.so", dir);
        g.ggml = lrs_open(gpath);
        if (g.ggml) {
            g.load_all_from_path =
                (fn_load_all_from_path) lrs_sym(g.ggml, "ggml_backend_load_all_from_path");
        }
    }
#endif
    if (!g.load_all_from_path) {
        lrs_set_error("no se encontro ggml_backend_load_all_from_path en ggml.dll");
        lrs_unload_lib();
        return LRS_LOAD_ERR_SYMBOL;
    }

    /* Ya se puede registrar el backend de CPU. Ver lrs_register_backends: sin esto
       el modelo carga pero la inicializacion del estado aborta el proceso. */
    lrs_register_backends(dir);

    g.error[0] = '\0';
    return LRS_LOAD_OK;
}

/* `true` si whisper.dll esta cargada. */
LRS_API bool lrs_whisper_is_loaded(void) {
    return g.lib != NULL;
}

/* Commit de whisper.cpp con el que se compilo este shim. */
LRS_API const char * lrs_whisper_build(void) {
    return LRS_WHISPER_BUILD;
}

/*
 * Crea un contexto desde `model_path`.
 *
 * `n_threads` NO se aplica aqui: en whisper.cpp actual `whisper_context_params` ya
 * no tiene `n_threads` (los hilos son un parametro de decodificacion, en
 * `whisper_full_params`). Se guarda para usarlo en `lrs_whisper_transcribe`.
 * `n_threads <= 0` deja el valor por defecto de whisper.
 *
 * Devuelve NULL si falla; el motivo queda en lrs_whisper_last_error().
 */
LRS_API struct whisper_context * lrs_whisper_init(const char * model_path, int n_threads) {
    if (!g.lib || !model_path) {
        lrs_set_error("el runtime no esta cargado");
        return NULL;
    }
    g.n_threads = n_threads;

    struct whisper_context_params cp = g.ctx_default_params();
    /* GPU fuera a proposito: el objetivo es una maquina sin GPU con ~1 GB de RAM.
       Con la GPU activa, ggml cae a Vulkan/CUDA y la carga falla. */
    cp.use_gpu = false;

    struct whisper_context * ctx = g.init_file(model_path, cp);
    if (!ctx) {
        lrs_set_error("no se pudo cargar el modelo desde el fichero");
    }
    return ctx;
}

/* Libera un contexto. NULL es un no-op. */
LRS_API void lrs_whisper_free(struct whisper_context * ctx) {
    if (ctx && g.lib) {
        g.free(ctx);
    }
}

/*
 * Crea un estado de decodificacion reutilizable.
 *
 * Es lo que hace viable el streaming: el estado conserva el KV cache entre
 * ventanas, asi que decodificar un segmento de 5 s no exige rehacer el encoder
 * desde cero como haria `whisper_full`. Devuelve NULL si falla.
 */
LRS_API struct whisper_state * lrs_whisper_init_state(struct whisper_context * ctx) {
    if (!g.lib || !ctx) {
        lrs_set_error("el runtime no esta cargado");
        return NULL;
    }
    struct whisper_state * st = g.init_state(ctx);
    if (!st) {
        lrs_set_error("no se pudo crear el estado de decodificacion");
    }
    return st;
}

/* Libera un estado de decodificacion. NULL es un no-op. */
LRS_API void lrs_whisper_free_state(struct whisper_state * st) {
    if (st && g.lib) {
        g.free_state(st);
    }
}

/* Numero de hilos con los que se inicializo el contexto, o -1. */
LRS_API int lrs_whisper_n_threads(void) {
    return g.n_threads;
}

/*
 * Transcribe `n_samples` muestras a 16 kHz mono en [-1, 1] usando `state`.
 *
 * `language` es "es", "en", "auto" o NULL (NULL equivale a "auto").
 * `single_segment` fuerza una sola frase, que es lo que quiere una ventana
 * corta. `no_context` evita que el texto anterior condicione el siguiente.
 * `detect_language` pide deteccion automatica cuando no se fija `language`.
 *
 * Devuelve el texto malloc'd (hay que liberarlo con lrs_whisper_free_string), o
 * NULL si la inferencia fallo. Una cadena vacia es un resultado VALIDO: significa
 * que la inferencia corrio y no hallo palabras, que es distinto de un error.
 */
LRS_API char * lrs_whisper_transcribe(struct whisper_context * ctx,
                                     struct whisper_state  * st,
                                     const float * samples, int n_samples,
                                     const char * language,
                                     bool single_segment,
                                     bool no_context,
                                     bool detect_language) {
    if (!g.lib) {
        lrs_set_error("el runtime no esta cargado");
        return NULL;
    }
    if (!ctx || !st || !samples || n_samples <= 0) {
        lrs_set_error("argumentos invalidos para la inferencia");
        return NULL;
    }

    struct whisper_full_params p = g.default_params(WHISPER_SAMPLING_GREEDY);
    if (g.n_threads > 0) {
        p.n_threads = g.n_threads;
    }

    /* En ventanas cortas el texto anterior no debe condicionar el siguiente: sin
       esto el modelo tiende a "continuar" lo ya transcrito y se repite. */
    p.no_context       = no_context;
    p.single_segment   = single_segment;
    p.no_timestamps    = true;
    p.print_progress   = false;
    p.print_realtime   = false;
    p.print_timestamps = false;
    p.print_special    = false;
    p.translate        = false;

    /* whisper NO copia `language`: el puntero debe sobrevivir a la llamada. Se
       apunta al argumento del llamante, valido durante todo el whisper_full de
       abajo, asi que no hace falta un buffer global estatico. */
    if (language && language[0] && strcmp(language, "auto") != 0) {
        p.language        = language;
        p.detect_language = false;
    } else {
        p.language        = NULL;   /* NULL = deteccion automatica */
        p.detect_language = detect_language || (language == NULL);
    }

    if (g.full_with_state(ctx, st, p, samples, n_samples) != 0) {
        lrs_set_error("whisper_full_with_state devolvio un error");
        return NULL;
    }

    const int n = g.n_segments(st);
    if (n <= 0) {
        /* Sin segmentos se devuelve cadena vacia, no NULL: el llamante distingue
           "no hablo" de "fallo" sin ambiguedad. */
        char * empty = (char *) malloc(1);
        if (empty) { empty[0] = '\0'; }
        return empty;
    }

    size_t total = 1;
    for (int i = 0; i < n; i++) {
        const char * t = g.seg_text(st, i);
        if (t) { total += strlen(t) + 1; }
    }
    char * buf = (char *) malloc(total);
    if (!buf) {
        lrs_set_error("sin memoria para el texto de la transcripcion");
        return NULL;
    }

    size_t off = 0;
    buf[0] = '\0';
    for (int i = 0; i < n; i++) {
        const char * t = g.seg_text(st, i);
        if (!t) { continue; }
        while (*t == ' ') { t++; }        /* whisper mete espacios al inicio */
        if (!*t) { continue; }
        const size_t len = strlen(t);
        if (off > 0) { buf[off++] = ' '; }
        memcpy(buf + off, t, len);
        off += len;
        buf[off] = '\0';
    }
    return buf;
}

/* Numero de segmentos de la ultima transcripcion. */
LRS_API int lrs_whisper_n_segments(struct whisper_state * st) {
    if (!g.lib || !st) { return 0; }
    return g.n_segments(st);
}

/* Inicio, en centisegundos, del segmento `i` de la ultima transcripcion. */
LRS_API int64_t lrs_whisper_segment_t0(struct whisper_state * st, int i) {
    if (!g.lib || !st) { return 0; }
    return g.seg_t0(st, i);
}

/* Fin, en centisegundos, del segmento `i` de la ultima transcripcion. */
LRS_API int64_t lrs_whisper_segment_t1(struct whisper_state * st, int i) {
    if (!g.lib || !st) { return 0; }
    return g.seg_t1(st, i);
}

/* Idioma detectado en la ultima pasada, o -1. */
LRS_API int lrs_whisper_detected_language(struct whisper_context * ctx) {
    if (!g.lib || !ctx) { return -1; }
    return g.lang_id(ctx);
}

/* Nombre del idioma detectado, o "" si no se sabe. Puntero estatico, no liberar. */
LRS_API const char * lrs_whisper_detected_language_str(struct whisper_context * ctx) {
    if (!g.lib || !ctx) { return ""; }
    const int id = g.lang_id(ctx);
    if (id < 0) { return ""; }
    return g.lang_str(id);
}

/* Traduce "es"/"en" al id numerico de whisper, o -1 si es "auto" o desconocido. */
LRS_API int lrs_whisper_lang_id(const char * code) {
    if (!g.lib || !code) { return -1; }
    if (code[0] == '\0' || strcmp(code, "auto") == 0) { return -1; }
    return g.lang_id_str(code);
}

/* `true` si el modelo habla mas de un idioma. */
LRS_API bool lrs_whisper_is_multilingual(struct whisper_context * ctx) {
    if (!g.lib || !ctx) { return false; }
    return g.is_multilingual(ctx) != 0;
}

/* Ultimo mensaje de error, o "" si no hubo. Puntero estatico, no liberar. */
LRS_API const char * lrs_whisper_last_error(void) {
    return g.error[0] ? g.error : "";
}

/* Libera una cadena devuelta por este modulo. */
LRS_API void lrs_whisper_free_string(char * s) {
    free(s);
}

#ifdef __cplusplus
}
#endif
