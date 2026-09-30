# Despliega el runtime de whisper.cpp que usa LyricStream.
#
# El runtime NO esta en el repo: son ~11 MB de binarios de terceros que cambian con
# cada release, y versionarlos daria conflictos constantes sin ganar nada. Es el mismo
# criterio que ya se aplica a los pesos del modelo, que tambien se descargan.
#
# Se usa el `curl.exe` del sistema, no `Invoke-WebRequest`, por el mismo motivo que en
# `CurlFetcher`: no compilar TLS en un equipo de 8 GB de RAM de los que solo queda ~1 GB
# libre durante la compilacion.
#
# Uso (desde la raiz del repo):
#
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-whisper.ps1
#
# Se deja en `src-tauri\crates\lyricstream-whisper-sys\runtime\`, que es donde lo
# buscan los tests de integracion. Para la app empaquetada, Tauri lo copia desde ahi
# como recurso del bundle.

$ErrorActionPreference = 'Stop'

# b5130 es el commit cuyas CABECERAS estan vendorizadas en
# `crates\lyricstream-whisper-sys\vendor\whisper\`. Si se cambia este tag, hay que
# actualizar tambien las cabeceras y `LRS_WHISPER_BUILD` en `csrc\shim.c`; el test
# `el_runtime_carga_y_expone_el_commit_esperado` falla si no coinciden.
$tag = 'b5130'
$url = "https://github.com/ggml-org/whisper.cpp/releases/download/$tag/whisper-bin-x64.zip"

$root = Split-Path -Parent $PSScriptRoot
$sysDir = Join-Path $root 'src-tauri\crates\lyricstream-whisper-sys'
$outDir = Join-Path $sysDir 'runtime'
$tmpDir = Join-Path $env:TEMP "whisper-$tag"

if (Test-Path -LiteralPath $outDir) {
  Write-Host "Actualizando el runtime existente en $outDir"
} else {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

if (-not (Test-Path -LiteralPath (Join-Path $tmpDir 'whisper.dll'))) {
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $zip = Join-Path $tmpDir 'whisper-bin-x64.zip'
  Write-Host "Descargando $url"
  & curl.exe -sL --fail -o $zip $url
  if ($LASTEXITCODE -ne 0) {
    throw "curl.exe fallo con codigo $LASTEXITCODE"
  }
  Expand-Archive -LiteralPath $zip -DestinationPath $tmpDir -Force
}

$source = Get-ChildItem -LiteralPath $tmpDir -Recurse -Filter 'whisper.dll' |
  Select-Object -First 1 -ExpandProperty DirectoryName

if (-not $source) {
  throw "el zip no contenia whisper.dll"
}

# Solo se copian las DLL que hacen falta. El zip trae tambien llama.dll, parakeet.dll
# y SDL2.dll, que son de otros programas del mismo repo y aqui no se usan: subiran el
# tamano del despliegue en 5 MB sin cambiar nada.
# Las variantes `ggml-cpu-*.dll` SI se copian todas: `ggml_backend_load_all_from_path`
# las recorre y elige la mejor para la CPU actual, asi que quitarlas haria que la app
# no encontrase backend en otras maquinas.
#
# `ggml-base.dll` es obligatoria aunque no suene a whisper: tanto `whisper.dll` como
# `ggml.dll` la importan, y si falta, `LoadLibrary` de whisper.dll falla con
# "no se encontro el modulo especificado" sin dar ninguna pista de cual falta. No se
# puede deducir mirando los nombres de los exports, hay que mirar la tabla de
# importaciones.
$required = 'whisper.dll', 'ggml.dll', 'ggml-base.dll'
$copied = 0
foreach ($file in Get-ChildItem -LiteralPath $source -Filter '*.dll') {
  $keep = $required -contains $file.Name -or $file.Name -like 'ggml-cpu-*'
  if ($keep) {
    Copy-Item -LiteralPath $file.FullName -Destination $outDir -Force
    $copied++
  }
}

# Comprobacion de que no falta ninguna importada. Un `LoadLibrary` fallido aqui
# reportaria "no se encontro whisper.dll", que es un diagnostico falso: el fichero
# esta, lo que falta es una dependencia suya.
$missing = @()
foreach ($name in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $outDir $name))) {
    $missing += $name
  }
}
if ($missing.Count -gt 0) {
  throw "faltan DLL obligatorias: $($missing -join ', ')"
}

Write-Host "Runtime de whisper.cpp $tag desplegado: $copied DLL en $outDir"
Get-ChildItem -LiteralPath $outDir -Filter '*.dll' |
  Sort-Object Name |
  ForEach-Object { '  {0,-28} {1,8:N0} KB' -f $_.Name, ($_.Length / 1KB) }

# El WAV de muestra que usan los tests de integracion. Se descarga aparte y no hace
# falta para la app.
$wav = Join-Path $outDir 'jfk.wav'
if (-not (Test-Path -LiteralPath $wav)) {
  $wavUrl = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/$tag/samples/jfk.wav"
  & curl.exe -sL --fail -o $wav $wavUrl
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Muestra de voz para los tests: $wav"
  }
  else {
    Write-Warning "no se pudo descargar jfk.wav; los tests de voz se omitiran"
  }
}
