@echo off
rem Starts the deck like "npm start" does. For Windows' Startup folder: see README, "Start automatically on login".
title Virtual Stream Deck
cd /d "%~dp0..\.."
set NODE_ENV=production
node --env-file-if-exists=.env server\index.ts
rem Keep the window open if it stopped with an error, so the message can be read.
if errorlevel 1 pause
