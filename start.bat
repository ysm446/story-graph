@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ---- Node 依存関係 ----
if not exist node_modules (
    echo [start] node_modules がありません。npm install を実行します...
    call npm install
    if errorlevel 1 (
        echo [start] npm install に失敗しました。
        pause
        exit /b 1
    )
)

rem ---- Python venv (バックエンド) ----
if not exist .venv\Scripts\python.exe (
    echo [start] .venv がありません。py -3.13 で作成します...
    py -3.13 -m venv .venv
    if errorlevel 1 (
        echo [start] venv の作成に失敗しました。Python 3.13 がインストールされているか確認してください。
        pause
        exit /b 1
    )
    .venv\Scripts\python.exe -m pip install --upgrade pip -q
    .venv\Scripts\python.exe -m pip install -r backend\requirements.txt -q
    if errorlevel 1 (
        echo [start] バックエンド依存のインストールに失敗しました。
        pause
        exit /b 1
    )
)

echo [start] Story Graph を起動します...
call npm run dev
if errorlevel 1 pause
