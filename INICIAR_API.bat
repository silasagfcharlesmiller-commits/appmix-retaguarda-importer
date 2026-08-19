@echo off
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" api_mix.py
) else (
    echo Ambiente Python nao encontrado. Execute INSTALAR_LIMPO.bat primeiro.
    pause
    exit /b 1
)
