@echo off
title HCPSS Greeter Voice Bot
cd /d "%~dp0"

echo ========================================================
echo   HCPSS Greeter Voice Bot Launcher
echo ========================================================
echo.

if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
    ) else (
        echo DISCORD_BOT_TOKEN=your_bot_token_here> .env
    )
    echo [!] Created hcpss-greeter\.env template.
    echo [!] Please open hcpss-greeter\.env and paste your DISCORD_BOT_TOKEN!
    echo.
    notepad .env
    pause
    exit /b 1
)

findstr /i /c:"your_bot_token_here" .env >nul
if %errorlevel% equ 0 (
    echo [!] NOTICE: hcpss-greeter\.env still contains the placeholder token.
    echo [!] Opening .env for you to paste your real DISCORD_BOT_TOKEN...
    notepad .env
    pause
    exit /b 1
)

echo Starting hcpss-greeter voice bot...
echo Discord Gateway connecting...
echo.

node index.js
pause
