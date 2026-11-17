@echo off
rem Double-click to start everything for Qorloop. Needs start-qorloop.ps1 in the same folder.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-qorloop.ps1"
pause
