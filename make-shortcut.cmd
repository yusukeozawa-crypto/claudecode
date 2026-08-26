@echo off
rem ============================================================
rem  Create a desktop shortcut for this tool.
rem  Double-click this file once. Japanese messages are printed by
rem  scripts\make-shortcut.ps1 (this file stays ASCII-only because
rem  non-ASCII text inside a .cmd breaks depending on the code page).
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-shortcut.ps1"
echo.
pause
