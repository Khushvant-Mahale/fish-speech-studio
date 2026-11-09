@echo off
title Fish Audio S2 Pro Studio
echo ============================================================
echo   Starting Fish Audio S2 Pro Story Studio...
echo ============================================================

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH!
    echo Please install Python 3.10+ and check 'Add Python to PATH'.
    pause
    exit /b 1
)

REM Install dependencies
echo [1/2] Checking dependencies...
python -m pip install -r requirements.txt --quiet

REM Launch Studio
echo [2/2] Launching Fish Audio S2 Pro Studio server on http://localhost:7865...
start http://localhost:7865
python app.py --port 7865
pause
