# Descarga e instala la release oficial de LyricStream STT.
#
# Pensado para la maquina del usuario final: baja el instalador NSIS publicado en GitHub
# Releases y, salvo que se pase `-DownloadOnly`, lo lanza. Tambien sirve desde CI.
#
# Se usa el `curl.exe` del sistema por el mismo motivo que en `deploy-whisper.ps1` y en
# `CurlFetcher`: no compilar TLS en un equipo de 8 GB de RAM.
#
# Uso (desde la raiz del repo o desde cualquier carpeta):
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-release.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-release.ps1 -Unattended
#   powershell -ExecutionPolicy Bypass -File scripts\install-release.ps1 -DownloadOnly
#
# Nota: el instalador de Tauri instala por usuario, asi que NO hace falta elevacion.
#
# El nombre del asset lleva la version dentro (`LyricStream.STT_0.1.0_x64-setup.exe`), asi
# que al publicar una version nueva hay que pasar `-Tag` y `-Asset` acordes.

[CmdletBinding()]
param(
  [string]$Repo = 'Lol-bit-Rvgl/GLL-Project1',
  [string]$Tag = 'v0.1.0',
  [string]$Asset = 'LyricStream.STT_0.1.0_x64-setup.exe',
  # Carpeta donde dejar el instalador; por defecto, la de temporales del usuario.
  [string]$Destination = $env:TEMP,
  # Instalacion silenciosa (asistente NSIS con `/S`).
  [switch]$Unattended,
  # Solo descargar, sin ejecutar el instalador.
  [switch]$DownloadOnly,
  # Si se indica, la descarga se aborta si el SHA-256 no coincide (comparacion sin
  # distingue mayusculas). No hay checksum publicado en la release, asi que es opcional.
  [string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'

$url = "https://github.com/$Repo/releases/download/$Tag/$Asset"
$target = Join-Path $Destination $Asset
# Se descarga a un temporal y solo se renombra cuando el fichero ya ha pasado todas las
# comprobaciones. `curl -o` sobre el destino directo TRUNCA el fichero antes de saber si la
# descarga va a funcionar, de modo que un tag mal escrito destruiria el instalador bueno
# que ya estuviera en la carpeta. Es el mismo criterio que la descarga del modelo, que
# escribe en un `.part` y renombra al terminar.
$partial = "$target.download"

Write-Host "Descargando LyricStream STT ($Tag)..." -ForegroundColor Cyan
Write-Host "  $url"

# `--fail` hace que curl devuelva un codigo distinto de cero ante un 404, en vez de
# escribir el HTML de error dentro del fichero como si fuera el instalador. Sin esto, un
# tag mal escrito dejaria un `.exe` que en realidad es una pagina de error.
& curl.exe -sL --fail -o $partial $url
if ($LASTEXITCODE -ne 0) {
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  throw "curl.exe fallo con codigo $LASTEXITCODE al descargar $url"
}

if (-not (Test-Path -LiteralPath $partial)) {
  throw "no se descargo ningun fichero en $partial"
}

# Doble comprobacion del contenido. `curl --fail` cubre el 404, pero un proxy cautivo o
# una red que responde 200 con una pagina de login tambien daria `--fail` = 0. Un
# ejecutable de Windows empieza por `MZ` (0x4D 0x5A); si no, no es un instalador y se tira.
$magic = [System.IO.File]::ReadAllBytes($partial)[0..1]
if ($magic[0] -ne 0x4D -or $magic[1] -ne 0x5A) {
  Remove-Item -LiteralPath $partial -Force
  throw ("lo descargado no es un ejecutable de Windows (cabecera {0:X2}{1:X2}); se elimino {2}" -f $magic[0], $magic[1], $partial)
}

$size = (Get-Item -LiteralPath $partial).Length
$hash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash
Write-Host "Instalador descargado: $target" -ForegroundColor Green
Write-Host ("  tamano: {0:N2} MB" -f ($size / 1MB))
Write-Host "  sha256: $hash"

if ($ExpectedSha256) {
  if ($hash -ne $ExpectedSha256.ToUpperInvariant()) {
    Remove-Item -LiteralPath $partial -Force
    throw "el SHA-256 no coincide: esperado $($ExpectedSha256.ToUpperInvariant()), obtenido $hash; no se instalo nada"
  }
  Write-Host "  hash verificado correctamente" -ForegroundColor Green
}

Move-Item -LiteralPath $partial -Destination $target -Force

if ($DownloadOnly) {
  Write-Host "Modo -DownloadOnly: no se ejecuta el instalador." -ForegroundColor Yellow
  return
}

if (-not [Environment]::UserInteractive) {
  throw "no hay sesion interactiva; usa -DownloadOnly para descargar sin instalar"
}

# `-Wait` dejaria el script colgado hasta que el usuario cerrara el asistente: se lanza y
# se devuelve el control. Se usa un nombre distinto de `$args`, que es automatico en
# PowerShell y no debe reasignarse.
$installerArgs = @()
if ($Unattended) { $installerArgs += '/S' }

Write-Host "Iniciando el instalador..." -ForegroundColor Yellow
Start-Process -FilePath $target -ArgumentList $installerArgs
Write-Host "Instalador lanzado. Completa la instalacion en el asistente." -ForegroundColor Green
