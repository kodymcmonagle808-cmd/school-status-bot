@echo off
setlocal enabledelayedexpansion
title SS Greeter Voice Bot
cd /d "%~dp0"

echo ========================================================
echo   SS Greeter Voice Bot Launcher
echo ========================================================
echo.

:: 1. Check if token was passed as command line argument
if not "%~1"=="" (
    echo DISCORD_BOT_TOKEN=%~1> .env
    echo [OK] Saved DISCORD_BOT_TOKEN to .env from arguments.
)

:: 2. Check if DISCORD_BOT_TOKEN environment variable is already set
if defined DISCORD_BOT_TOKEN (
    echo [OK] Using DISCORD_BOT_TOKEN from environment.
    goto :start
)

:: 3. Check if .env exists and has a real token
if exist .env (
    findstr /v /i /c:"your_bot_token_here" .env | findstr /i /c:"DISCORD_BOT_TOKEN=" >nul
    if !errorlevel! equ 0 (
        echo [OK] Using DISCORD_BOT_TOKEN from .env file.
        goto :start
    )
)

:: 4. Prompt user right in the terminal (no notepad popup needed)
echo [!] DISCORD_BOT_TOKEN is not yet configured.
echo.
echo Please paste your Discord Bot Token below:
echo (Right-click or Ctrl+V to paste)
echo.
set /p INPUT_TOKEN="Token: "

if "%INPUT_TOKEN%"=="" (
    echo.
    echo No token entered. Exiting.
    pause
    exit /b 1
)

echo DISCORD_BOT_TOKEN=%INPUT_TOKEN%> .env
echo.
echo [OK] Saved token to .env. Starting bot...
echo.

:start
echo Connecting to Discord Gateway...
echo Keep this window open while you want voice announcements active!
echo (Press Ctrl+C to stop)
echo.

node index.js

pause
