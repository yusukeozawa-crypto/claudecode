@echo off
rem ============================================================
rem  Post-release QA launcher for Windows.
rem  Double-click this file to run the QA checks.
rem  Requires Node.js: https://nodejs.org/ja
rem
rem  This file is intentionally ASCII-only. All Japanese output is
rem  produced by scripts/launcher.mjs, because non-ASCII text inside
rem  a .cmd file breaks depending on the console code page.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org/ja
  echo         and run this file again.
  pause
  exit /b 1
)

node scripts\launcher.mjs %*
set "QA_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %QA_EXIT%
