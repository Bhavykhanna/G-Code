@echo off
rem Launch G-code Studio: builds, starts the server and opens one app window.
rem Any previous G-code Studio window and server are closed first.
rem Mirrors run_tag_aligner.bat next door -- double-click and go.
rem The server runs with no console window (user, 2026-09-17); its output goes to
rem .server.log in this folder. Stop everything with stop-gcode-studio.bat.
pushd "%~dp0"
if not exist "node_modules" (
  echo First run: installing dependencies...
  call npm install
)
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ^
  "Start-Process -WindowStyle Hidden -FilePath cmd.exe -WorkingDirectory (Get-Location) -ArgumentList '/c','node scripts/dev.js --built > .server.log 2>&1'"
popd
