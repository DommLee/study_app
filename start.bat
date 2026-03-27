@echo off
title OmniTutor v3 Launcher
color 0A

set "COMPOSE_CMD=docker compose"
docker compose version >nul 2>&1
if %errorlevel% neq 0 (
    set "COMPOSE_CMD=docker-compose"
)

echo.
echo  ========================================
echo   OmniTutor v3 - AI Calisma Ekosistemi
echo  ========================================
echo.

docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [HATA] Docker calismiyor!
    echo Docker Desktop'i ac ve tekrar dene.
    echo.
    pause
    exit /b 1
)

echo [OK] Docker calisiyor
echo.

echo [*] Docker image olusturuluyor...
%COMPOSE_CMD% build
if %errorlevel% neq 0 (
    echo [HATA] Docker build basarisiz!
    pause
    exit /b 1
)

echo [*] OmniTutor v3 baslatiliyor...
%COMPOSE_CMD% up -d
if %errorlevel% neq 0 (
    echo [HATA] Container baslatilamadi!
    pause
    exit /b 1
)

echo.
echo  ========================================
echo   [BASARILI] OmniTutor v3 calisiyor!
echo.
echo   Adres: http://localhost:3030
echo.
echo   Ilk kullanim:
echo   1. Tarayici acilacak
echo   2. Sag ust kosedeki Ayarlar'a tikla
echo   3. Ollama icin localhost:11434 calisiyorsa provider'i Ollama sec
echo   4. Cloud provider kullanacaksan ilgili profile API key gir
echo  ========================================
echo.

echo Tarayici aciliyor...
start http://localhost:3030

echo Loglari gormek icin bir tusa bas...
pause >nul
%COMPOSE_CMD% logs -f
