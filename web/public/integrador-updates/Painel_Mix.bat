@echo off
setlocal EnableExtensions EnableDelayedExpansion
:: ============================================================================
:: PAINEL DE CONTROLE MIX FISCAL - MONITOR AUTOMATICO INVISIVEL
:: Baseado no Painel Mix fornecido pelo operador.
:: ============================================================================

:: Solicita permissao administrativa quando aberto manualmente.
net session >nul 2>&1
if %errorLevel% neq 0 (
    if "%~1"=="" (
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p=Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
    ) else (
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p=Start-Process -FilePath '%~f0' -ArgumentList '%~1' -WorkingDirectory '%~dp0' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
    )
    set "RESULTADO_ELEVADO=!errorlevel!"
    if not "!RESULTADO_ELEVADO!"=="0" (
        echo.
        echo ERRO: nao foi possivel solicitar permissao de administrador.
        echo Clique com o BOTAO DIREITO e escolha "Executar como administrador".
        echo.
        pause
    )
    exit /b !RESULTADO_ELEVADO!
)

:: Usa sempre a pasta onde este Painel_Mix.bat esta localizado.
set "PASTA_ATUAL=%~dp0"
if "%PASTA_ATUAL:~-1%"=="\" set "PASTA_ATUAL=%PASTA_ATUAL:~0,-1%"
set "PASTA_MIX=%PASTA_ATUAL%"

:: Detecta o executavel sem depender do nome da pasta.
set "NOME_EXE="
if exist "%PASTA_MIX%\desktop-integrador.exe" set "NOME_EXE=desktop-integrador.exe"
if not defined NOME_EXE (
    for %%F in ("%PASTA_MIX%\*integrador*.exe") do (
        if not defined NOME_EXE if exist "%%~fF" set "NOME_EXE=%%~nxF"
    )
)
if not defined NOME_EXE (
    for %%F in ("%PASTA_MIX%\*.exe") do (
        if /I not "%%~nxF"=="Instalador-Mix-Fiscal.exe" if not defined NOME_EXE if exist "%%~fF" set "NOME_EXE=%%~nxF"
    )
)
if not defined NOME_EXE set "NOME_EXE=desktop-integrador.exe"
set "NOME_PROCESSO=%NOME_EXE:.exe=%"
set "NOME_TAREFA=Mix Fiscal - Monitorar Integrador"
set "NOME_TAREFA_ANTIGA=Monitor_Mix_Fiscal"

set "VERSAO_INSTALADA=nao informada"
if exist "%PASTA_MIX%\integrador_version.json" for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$j=Get-Content -LiteralPath '%PASTA_MIX%\integrador_version.json' -Raw; $o=ConvertFrom-Json -InputObject $j; Write-Output $o.version"`) do set "VERSAO_INSTALADA=%%V"

if /I "%~1"=="--install-monitor" goto INSTALAR
if /I "%~1"=="--stop-monitor" goto DESINSTALAR

:MENU
cls
echo ============================================================================
echo             PAINEL DE CONTROLE - MONITOR MIX FISCAL v%VERSAO_INSTALADA%
echo ============================================================================
echo Configuracao detectada automaticamente:
echo   [1] Caminho da pasta : %PASTA_MIX%
echo   [2] Executavel       : %NOME_EXE%
echo   [3] Processo         : %NOME_PROCESSO%
echo   [4] Tarefa           : %NOME_TAREFA%
echo   [5] Versao instalada : %VERSAO_INSTALADA%
echo ============================================================================
echo ESCOLHA UMA OPCAO:
echo.
echo   [1] Alterar pasta / executavel manualmente
echo   [2] INSTALAR / ATIVAR monitoramento invisivel, a cada 5 min
echo   [3] INICIAR Integrador agora
echo   [4] PARAR Integrador e limpar processos travados
echo   [5] DESINSTALAR / DESATIVAR monitoramento automatico
echo   [6] Ver status / testar execucao agora
echo   [0] Sair
echo ============================================================================
set /p opcao="Digite o numero da opcao desejada e aperte Enter: "

if "%opcao%"=="1" goto ALTERAR_CONFIG
if "%opcao%"=="2" goto INSTALAR
if "%opcao%"=="3" goto INICIAR
if "%opcao%"=="4" goto PARAR
if "%opcao%"=="5" goto DESINSTALAR
if "%opcao%"=="6" goto STATUS
if "%opcao%"=="0" exit /b

echo.
echo Opcao invalida.
timeout /t 2 >nul
goto MENU

:ALTERAR_CONFIG
cls
echo ============================================================================
echo                    ALTERAR CONFIGURACOES DE CAMINHO
echo ============================================================================
echo.
set /p PASTA_MIX="1. Nova pasta (Atual: %PASTA_MIX%): "
set /p NOME_EXE="2. Novo executavel (Atual: %NOME_EXE%): "
set "NOME_PROCESSO=%NOME_EXE:.exe=%"
echo.
echo Configuracao atualizada.
pause
goto MENU

:VALIDAR_SCRIPTS
if not exist "%PASTA_MIX%\monitor_mix.ps1" (
    echo ERRO: monitor_mix.ps1 nao foi encontrado em %PASTA_MIX%.
    exit /b 2
)
if not exist "%PASTA_MIX%\run_silent.vbs" (
    echo ERRO: run_silent.vbs nao foi encontrado em %PASTA_MIX%.
    exit /b 2
)
if not exist "%PASTA_MIX%\atualizador_mix.ps1" (
    echo ERRO: atualizador_mix.ps1 nao foi encontrado em %PASTA_MIX%.
    exit /b 2
)
exit /b 0

:INSTALAR
cls
echo ============================================================================
echo              INSTALANDO / ATIVANDO MONITORAMENTO AUTOMATICO
echo ============================================================================
echo.
echo [1/2] Validando os componentes em: %PASTA_MIX%...
call :VALIDAR_SCRIPTS
if errorlevel 1 (
    if /I "%~1"=="--install-monitor" exit /b 2
    echo.
    pause
    goto MENU
)

echo [2/2] Cadastrando tarefa invisivel no Agendador do Windows...
call schtasks /end /tn "%NOME_TAREFA%" >nul 2>&1
call schtasks /delete /tn "%NOME_TAREFA%" /f >nul 2>&1
call schtasks /end /tn "%NOME_TAREFA_ANTIGA%" >nul 2>&1
call schtasks /delete /tn "%NOME_TAREFA_ANTIGA%" /f >nul 2>&1
call schtasks /create /tn "%NOME_TAREFA%" /tr "wscript.exe \"%PASTA_MIX%\run_silent.vbs\"" /sc minute /mo 5 /ru "%USERNAME%" /rl HIGHEST /f
set "RESULTADO_TAREFA=%errorLevel%"

:: Reativa as tarefas nativas que o Integrador possa ter criado.
call schtasks /change /tn "\MixFiscalIntegrador\BootStart" /enable >nul 2>&1
call schtasks /change /tn "\MixFiscalIntegrador\Startup" /enable >nul 2>&1
call schtasks /change /tn "\MixFiscalIntegrador\Watchdog" /enable >nul 2>&1

if %RESULTADO_TAREFA% equ 0 (
    echo.
    echo SUCESSO! Monitoramento ativado para:
    echo %PASTA_MIX%
    echo.
    echo As verificacoes serao invisiveis, sem piscar a tela.
) else (
    echo.
    echo ERRO ao cadastrar a tarefa agendada.
)
echo.
if /I "%~1"=="--install-monitor" exit /b %RESULTADO_TAREFA%
pause
goto MENU

:INICIAR
cls
if exist "%PASTA_MIX%\%NOME_EXE%" (
    start "" /d "%PASTA_MIX%" "%PASTA_MIX%\%NOME_EXE%"
    echo Executavel iniciado com sucesso.
) else (
    echo ERRO: arquivo nao encontrado em %PASTA_MIX%\%NOME_EXE%.
)
echo.
pause
goto MENU

:PARAR
cls
echo Encerrando o Integrador e os processos WebView2...
taskkill /f /im "%NOME_EXE%" >nul 2>&1
taskkill /f /im msedgewebview2.exe >nul 2>&1
echo Processos encerrados.
echo.
pause
goto MENU

:DESINSTALAR
cls
call schtasks /end /tn "%NOME_TAREFA%" >nul 2>&1
call schtasks /delete /tn "%NOME_TAREFA%" /f >nul 2>&1
call schtasks /end /tn "%NOME_TAREFA_ANTIGA%" >nul 2>&1
call schtasks /delete /tn "%NOME_TAREFA_ANTIGA%" /f >nul 2>&1
call schtasks /change /tn "\MixFiscalIntegrador\BootStart" /disable >nul 2>&1
call schtasks /change /tn "\MixFiscalIntegrador\Startup" /disable >nul 2>&1
call schtasks /change /tn "\MixFiscalIntegrador\Watchdog" /disable >nul 2>&1
echo Monitoramento automatico desativado com sucesso.
echo Agora use a opcao 4 para parar o Integrador durante a manutencao.
echo.
if /I "%~1"=="--stop-monitor" exit /b 0
pause
goto MENU

:STATUS
cls
echo ============================================================================
echo                     STATUS DO PROCESSO E DO MONITOR
echo ============================================================================
echo.
echo [VERSAO] %VERSAO_INSTALADA%
tasklist /fi "IMAGENAME eq %NOME_EXE%" 2>nul | findstr /I "%NOME_EXE%" >nul
if %errorlevel% equ 0 (
    echo [RODANDO] %NOME_EXE% esta em execucao.
) else (
    echo [PARADO] %NOME_EXE% nao esta rodando.
)

call schtasks /query /tn "%NOME_TAREFA%" >nul 2>&1
if %errorlevel% equ 0 (
    echo [ATIVO] O monitor invisivel esta instalado.
) else (
    echo [INATIVO] O monitor invisivel nao esta instalado.
)
echo.
pause
goto MENU
