@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title APP MIX
echo Verificando o ambiente e abrindo o APP MIX...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0primeira_execucao.ps1" -Modo interface

if errorlevel 1 (
    echo.
    echo Nao foi possivel abrir o APP MIX.
    echo Confira se o Python 3.11 ou superior esta instalado nesta maquina.
    pause
    exit /b 1
)

exit /b 0
