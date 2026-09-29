@echo off
rem HoudiniDeck as the Windows installer sets it up: the Node.js next to this file runs the deck, which
rem keeps its deck, settings, images and .env in %LOCALAPPDATA%\HoudiniDeck (kept across updates).
rem   --open  also open the deck in the browser (the Start menu shortcut)
rem   --data  just open that folder
setlocal
set "STREAMDECK_DATA_DIR=%LOCALAPPDATA%\HoudiniDeck"
if not exist "%STREAMDECK_DATA_DIR%" mkdir "%STREAMDECK_DATA_DIR%"
if /i "%~1"=="--data" (
  start "" explorer.exe "%STREAMDECK_DATA_DIR%"
  exit /b 0
)
if /i "%~1"=="--open" set "STREAMDECK_OPEN_BROWSER=1"
title HoudiniDeck
cd /d "%STREAMDECK_DATA_DIR%"
set "NODE_ENV=production"
rem Tells the deck it can update itself by running a newer installer.
set "STREAMDECK_PACKAGE=windows-installer"
"%~dp0node.exe" --env-file-if-exists=.env "%~dp0app\server\index.ts"
rem Keep the window open if it stopped with an error, so the message can be read.
if errorlevel 1 pause
