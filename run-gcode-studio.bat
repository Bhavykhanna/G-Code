@echo off
rem Launch G-code Studio: builds, starts the server and opens one app window.
rem Double-click and go.
rem
rem Closing the app window with the X leaves the server (and the Claude session
rem inside it) running on purpose. Running this again then just opens a new
rem window onto it, which is instant. For a clean restart -- after changing
rem server code, say:
rem
rem     run-gcode-studio.bat --force        (or stop-gcode-studio.bat first)
rem
rem The server runs with no console window (user, 2026-09-17); its output goes to
rem .server.log in this folder. Stop everything with stop-gcode-studio.bat.
pushd "%~dp0"
if not exist "node_modules" (
  echo First run: installing dependencies...
  call npm install
)
set "GCS_FORCE="
if /i "%~1"=="--force" set "GCS_FORCE=-Force"
if /i "%~1"=="-force" set "GCS_FORCE=-Force"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "scripts\launch.ps1" -Root "%~dp0." %GCS_FORCE%
popd
