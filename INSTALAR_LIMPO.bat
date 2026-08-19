@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if /I "%~1"=="--verificar" goto verificar

echo ==================================================
echo       APP MIX - INSTALACAO LIMPA
echo ==================================================
echo.
echo Este instalador apagara SOMENTE estas pastas dentro de:
echo %CD%
echo.
echo   .venv
echo   playwright-browsers
echo   playwright-profile
echo   __pycache__
echo   erros_automacao
echo.
echo O codigo, config_mix.json e os mapeamentos serao preservados.
echo A sessao/login anterior sera apagada.
echo.
set /p "CONFIRMA=Digite INSTALAR para continuar: "
if /I not "%CONFIRMA%"=="INSTALAR" (
    echo Instalacao cancelada. Nada foi apagado.
    exit /b 1
)

call :remover_pasta ".venv"
call :remover_pasta "playwright-browsers"
call :remover_pasta "playwright-profile"
call :remover_pasta "__pycache__"
call :remover_pasta "erros_automacao"

if exist "worker_mix.log" del /q "worker_mix.log"

echo.
echo Criando ambiente e instalando bibliotecas da versao API...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0primeira_execucao.ps1" -Modo interface
if errorlevel 1 (
    echo.
    echo ERRO: a instalacao nao foi concluida.
    pause
    exit /b 1
)

echo.
echo Instalacao concluida.
exit /b 0

:remover_pasta
set "ALVO=%~dp0%~1"
if exist "%ALVO%\" (
    echo Removendo %ALVO%
    rmdir /s /q "%ALVO%"
)
exit /b 0

:verificar
echo Verificando arquivos do instalador em %CD%...
set "FALTOU=0"
for %%F in (
    "primeira_execucao.ps1"
    "requirements.txt"
    "appmix.pyw"
    "worker_mix.py"
    "automacao_api.py"
    "api_mix.py"
    "automacao_core.py"
    "automacao_login.py"
    "automacao_tabela.py"
    "automacao_compara_divergencia.py"
    "comparar_divergencia_widget.py"
    "database.py"
    "mapeamento_portal_mix.json"
    "mapeamento_configuracoes.json"
    "config_mix.json"
    "INICIAR_API.bat"
    "INICIAR_WORKER_API.bat"
) do (
    if not exist "%%~F" (
        echo AUSENTE: %%~F
        set "FALTOU=1"
    )
)
if "%FALTOU%"=="1" exit /b 1
echo Todos os arquivos obrigatorios estao presentes.
exit /b 0
