# launch.ps1 -- start G-code Studio with no console window.
#
# Called by run-gcode-studio.bat. All it does is start `node scripts/dev.js`
# hidden; dev.js decides whether that means a fresh start or just another window
# onto the server that is already running, and writes .server.log itself.
#
# Why it does NOT redirect the output here (2026-09-19): `cmd /c ... > .server.log`
# takes an exclusive handle on the log. While an older hidden instance was still
# alive -- which is exactly what happens when the app window is closed with the X --
# the next launch died on that redirect before node ever ran, so double-clicking
# the .bat appeared to do nothing at all. dev.js opens the log itself, and node's
# handles share.
param(
  [string]$Root = (Get-Location).Path,
  [switch]$Force,
  [switch]$Dev      # Vite hot-reload mode instead of the built bundle
)
$ErrorActionPreference = 'Stop'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  # No console to print to, so say it where the user has been told to look.
  $msg = "$(Get-Date -Format s)  cannot start: node is not on PATH. Install Node.js, or run 'npm start' from a terminal."
  Set-Content -Path (Join-Path $Root '.server.log') -Value $msg -Encoding utf8
  exit 1
}

$argList = @('scripts/dev.js')
if (-not $Dev) { $argList += '--built' }
if ($Force)    { $argList += '--force' }

Start-Process -FilePath $node -ArgumentList $argList -WorkingDirectory $Root -WindowStyle Hidden
