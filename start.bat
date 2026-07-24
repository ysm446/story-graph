@echo off
setlocal
cd /d "%~dp0"

rem ---- Node dependencies ----
if not exist node_modules (
    echo [start] Installing npm dependencies...
    call npm install
    if errorlevel 1 (
        echo [start] npm install failed.
        pause
        exit /b 1
    )
)

rem ---- Python venv for backend ----
if not exist .venv\Scripts\python.exe (
    echo [start] Creating .venv with Python 3.13...
    py -3.13 -m venv .venv
    if errorlevel 1 (
        echo [start] Failed to create venv. Is Python 3.13 installed?
        pause
        exit /b 1
    )
    .venv\Scripts\python.exe -m pip install --upgrade pip -q
    .venv\Scripts\python.exe -m pip install -r backend\requirements.txt -q
    if errorlevel 1 (
        echo [start] Failed to install backend dependencies.
        pause
        exit /b 1
    )
)

echo [start] Launching Story Graph...
call npm run dev
if errorlevel 1 pause
