@echo off
rem UBER_LOG daily official import: pick the latest inbox date and start Claude Code with /uber-import <date>
rem Logic lives in tools\official-import\run-latest-import.ps1
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\official-import\run-latest-import.ps1"
