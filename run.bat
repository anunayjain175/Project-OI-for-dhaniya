@echo off
title Indira ODIN OI Charting Dashboard
echo =====================================================================
echo          INDIRA ODIN REAL-TIME OPEN INTEREST (OI) TERMINAL
echo =====================================================================
echo.

:: Check Python installation
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in the system PATH.
    echo.
    echo Please download and install Python 3.9 or higher from:
    echo https://www.python.org/downloads/
    echo.
    echo CRITICAL: Make sure to check the box "Add Python to PATH" during setup.
    echo.
    pause
    exit /b 1
)

echo [INFO] Python detected successfully.
echo [INFO] Verifying and installing required packages...
echo.
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install python dependencies. Please check your internet connection.
    pause
    exit /b 1
)

echo.
echo [INFO] All dependencies verified!
echo [INFO] Launching terminal dashboard web server at http://localhost:8000 ...
echo.

:: Delay for 2 seconds then launch default browser
ping 127.0.0.1 -n 3 >nul
start http://localhost:8000/

:: Run FastAPI application
python backend/main.py
pause
