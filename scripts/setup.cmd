@echo off
:: setup.cmd — Windows launcher for Prevoyant setup
:: Double-click this file (or run from CMD) to install prerequisites.
:: Calls setup.ps1 via PowerShell automatically.
setlocal
pushd "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
popd
echo.
pause
