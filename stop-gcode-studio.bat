@echo off
rem Stop G-code Studio: closes the app window and the (hidden) server.
rem This also ends the Claude session running inside the app.
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "scripts\close-previous.ps1" -Profile "%~dp0.app-profile" -Ports "5173,5174"
popd
