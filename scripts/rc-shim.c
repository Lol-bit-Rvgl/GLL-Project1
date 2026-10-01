/*
 * Puente entre `embed-resource` y GNU windres para el cruce MSVC-host -> GNU-target.
 *
 * El problema, que costo tres ejecuciones de CI: `embed-resource` elige el compilador de
 * recursos con un `#[cfg(target_env = "msvc")]`, o sea por el HOST con el que se compilo el
 * propio crate, no por el target. En un `windows-latest` el host es MSVC, asi que usa
 * `windows_msvc.rs`: nombra la salida `resource.lib` e invoca `rc.exe /fo <out> /I <dir> <in.rc>`.
 * Ese `.lib` es en realidad un `.res` en formato de recursos de Microsoft, y el `ld` de GNU
 * lo rechaza con `file format not recognized`, tumbando el enlazado entero.
 *
 * En local no se ve porque el host es GNU: ahi entra por `windows_not_msvc.rs`, que usa
 * `windres` y produce un COFF valido. De ahi que el build pase en la maquina de desarrollo
 * y falle en el runner.
 *
 * `windows_msvc.rs` respeta la variable de entorno `RC` (y `RC_<target>`), asi que basta con
 * apuntarla a este shim: recibe los argumentos estilo MSVC y los traduce a los de windres.
 * No se puede apuntar `RC` directamente a `windres` porque windres no entiende `/fo` ni `/I`
 * (comprobado: devuelve el uso y exit 1).
 *
 * Uso:  set RC=<ruta>\rc-shim.exe   (lo hace scripts/rc-shim.ps1 en CI)
 */
#include <stdio.h>
#include <string.h>
#include <process.h>

/* El numero de argumentos que embed-resource pasa es diminuto (unos pocos), pero el margen
 * no cuesta nada y evita una cuenta fragile. */
#define MAX_ARGS 256

int main(int argc, char **argv) {
    const char *nuevos[MAX_ARGS + 2];
    int n = 0;
    const char *entrada = NULL;

    nuevos[n++] = "windres";

    for (int i = 1; i < argc; i++) {
        char *a = argv[i];

        if (strcmp(a, "/fo") == 0 && i + 1 < argc) {
            /* ruta de salida */
            nuevos[n++] = "-o";
            nuevos[n++] = argv[++i];
        } else if (strcmp(a, "/I") == 0 && i + 1 < argc) {
            nuevos[n++] = "-I";
            nuevos[n++] = argv[++i];
        } else if (strcmp(a, "/D") == 0 && i + 1 < argc) {
            nuevos[n++] = "-D";
            nuevos[n++] = argv[++i];
        } else if (strcmp(a, "/U") == 0 && i + 1 < argc) {
            nuevos[n++] = "-U";
            nuevos[n++] = argv[++i];
        } else if (a[0] == '/' && a[1] != '\0') {
            /* Otra opcion estilo MSVC que windres no conoce (por ejemplo /nologo). Se
             * descarta en vez de pasarla: pasarla haria fallar a windres por argumento
             * desconocido. Las rutas absolutas de Windows empiezan por letra de unidad, no
             * por barra, asi que esta rama no puede tragarse el fichero de entrada. */
            continue;
        } else {
            /* El fichero .rc (el ultimo argumento que no es opcion). */
            entrada = a;
        }

        if (n > MAX_ARGS) {
            fprintf(stderr, "rc-shim: demasiados argumentos\n");
            return 2;
        }
    }

    if (entrada == NULL) {
        fprintf(stderr, "rc-shim: no se recibio ningun fichero .rc\n");
        return 2;
    }

    /* `--output-format=coff` es obligatorio: embed-resource nombra la salida `.lib`, y si
     * windres dedujese el formato de la extension no sabria que hacer. Y es justo el COFF lo
     * que el enlazador de GNU sabe leer. Se anade al final; getopt lo acepta en cualquier
     * posicion. */
    nuevos[n++] = "--output-format=coff";
    nuevos[n++] = entrada;
    nuevos[n] = NULL;

    return (int)_spawnvp(_P_WAIT, "windres", (const char *const *)nuevos);
}
