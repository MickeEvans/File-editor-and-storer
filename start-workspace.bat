@echo off
rem Launch the workspace app and open it in the browser.
rem Double-click this file (or a shortcut to it) from anywhere.
title Workspace server
cd /d "%~dp0"

rem Open the browser once the server has had a moment to start
start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:8000"

echo Workspace running at http://localhost:8000
echo Close this window (or press Ctrl+C) to stop it.
.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
