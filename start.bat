@echo off
title IDLE TESTING MONITOR

:: Add Node.js to PATH if not already available
set "PATH=C:\Program Files\nodejs;%PATH%"

echo Checking for existing process on port 80...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":80 " ^| findstr "LISTENING"') do (
    echo Stopping PID %%a on port 80...
    taskkill /PID %%a /F >nul 2>&1
)

echo Installing dependencies (if needed)...
if not exist "node_modules" (
    npm install
)

echo Starting IDLE TESTING MONITOR...
echo Open http://localhost in your browser.
echo Press Ctrl+C to stop the server.
echo.
npm start
pause
