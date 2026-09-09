@echo off
:: ==============================================================================
:: PAINEL DE CONTROLE MIX FISCAL - MONITOR AUTOMATICO DINAMICO E INVISIVEL
:: ==============================================================================

:: Verifica Permissoes de Administrador
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs"
    if errorlevel 1 (
        echo.
        echo ERRO: nao foi possivel solicitar permissao de administrador.
        echo Clique com o BOTAO DIREITO e escolha "Executar como administrador".
        echo.
        pause
    )
    exit /b
)

:: Pega o caminho absoluto da pasta onde ESTE arquivo .bat esta localizado
set "PASTA_ATUAL=%~dp0"
if "%PASTA_ATUAL:~-1%"=="\" set "PASTA_ATUAL=%PASTA_ATUAL:~0,-1%"

:: Definicao das variaveis padrao
set "PASTA_MIX=%PASTA_ATUAL%"
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
set "VERSAO_INSTALADA=nao informada"
if exist "%PASTA_MIX%\integrador_version.json" for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$j=Get-Content -LiteralPath '%PASTA_MIX%\integrador_version.json' -Raw; $o=ConvertFrom-Json -InputObject $j; Write-Output $o.version"`) do set "VERSAO_INSTALADA=%%V"

if /I "%~1"=="--install-monitor" goto INSTALAR
if /I "%~1"=="--stop-monitor" goto DESINSTALAR

:MENU
cls
echo ==============================================================================
echo             PAINEL DE CONTROLE - MONITOR MIX FISCAL v%VERSAO_INSTALADA%
echo ==============================================================================
echo Configuracao Detectada Automaticamente:
echo   [1] Caminho da Pasta : %PASTA_MIX%
echo   [2] Nome do Executavel: %NOME_EXE%
echo   [3] Nome do Processo  : %NOME_PROCESSO%
echo   [4] Nome da Tarefa    : %NOME_TAREFA%
echo   [5] Versao instalada  : %VERSAO_INSTALADA%
echo ==============================================================================
echo ESCOLHA UMA OPCAO:
echo.
echo   [1] Alterar Pasta / Executavel Manualmente
echo   [2] MONITORAR INTEGRADOR - Instalar / ativar (a cada 5 min)
echo   [3] INICIAR Integrador Agora
echo   [4] PARAR Integrador e Limpar Processos Travados
echo   [5] PARAR MONITORAMENTO (para manutencao)
echo   [6] Ver Status / Testar Execucao Agora
echo   [0] Sair
echo ==============================================================================
set /p opcao="Digite o numero da opcao desejada e aperte Enter: "

if "%opcao%"=="1" goto ALTERAR_CONFIG
if "%opcao%"=="2" goto INSTALAR
if "%opcao%"=="3" goto INICIAR
if "%opcao%"=="4" goto PARAR
if "%opcao%"=="5" goto DESINSTALAR
if "%opcao%"=="6" goto STATUS
if "%opcao%"=="0" exit /b

echo.
echo Opcao invalida!
timeout /t 2 >nul
goto MENU

:ALTERAR_CONFIG
cls
echo ==============================================================================
echo                     ALTERAR CONFIGURACOES DE CAMINHO
echo ==============================================================================
echo.
set /p PASTA_MIX="1. Nova Pasta (Atual: %PASTA_MIX%): "
set /p NOME_EXE="2. Novo Executavel (Atual: %NOME_EXE%): "
set "NOME_PROCESSO=%NOME_EXE:.exe=%"
echo.
echo Configuracao atualizada!
pause
goto MENU

:GERAR_SCRIPTS
if not exist "%PASTA_MIX%" (
    mkdir "%PASTA_MIX%"
)

:: 1. Gera o Script PowerShell de monitoramento
set "SCRIPT_PS1=%PASTA_MIX%\monitor_mix.ps1"
(
    echo $pastaMix       = "%PASTA_MIX%"
    echo $nomeExecutavel = "%NOME_EXE%"
    echo $nomeProcesso   = "%NOME_PROCESSO%"
    echo $arquivoLog     = "monitor_log.txt"
    echo $atualizador    = Join-Path -Path $pastaMix -ChildPath "atualizador_mix.ps1"
    echo if ^(Test-Path -LiteralPath $atualizador^) { ^& $atualizador }
    echo $caminhoCompletoExe = Join-Path -Path $pastaMix -ChildPath $nomeExecutavel
    echo $caminhoCompletoLog = Join-Path -Path $pastaMix -ChildPath $arquivoLog
    echo $processoRodando = Get-Process -Name $nomeProcesso -ErrorAction SilentlyContinue
    echo if ^(-not $processoRodando^) {
    echo     $dataHora = Get-Date -Format "dd/MM/yyyy HH:mm:ss"
    echo     $mensagemLog = "[$dataHora] ALERTA: O integrador nao estava rodando. Reiniciando..."
    echo     Add-Content -Path $caminhoCompletoLog -Value $mensagemLog -Encoding UTF8
    echo     Start-Process -FilePath $caminhoCompletoExe -WorkingDirectory $pastaMix
    echo }
) > "%SCRIPT_PS1%"

:: 2. Gera o Lancador VBScript para rodar o PowerShell em modo 100% Oculto
set "SCRIPT_VBS=%PASTA_MIX%\run_silent.vbs"
(
    echo Set objShell = CreateObject("WScript.Shell"^)
    echo objShell.Run "powershell.exe -ExecutionPolicy Bypass -NoProfile -File """ ^& "%PASTA_MIX%\monitor_mix.ps1" ^& """", 0, False
) > "%SCRIPT_VBS%"
exit /b

:INSTALAR
cls
echo ==============================================================================
echo                    MONITORAR INTEGRADOR
echo ==============================================================================
echo.
echo [1/2] Gerando scripts dinamicamente em: %PASTA_MIX%...
call :GERAR_SCRIPTS

echo [2/2] Cadastrando tarefa silenciosa no Agendador do Windows...
schtasks /delete /tn "%NOME_TAREFA%" /f >nul 2>&1

:: Utiliza wscript.exe para chamar o VBS em segundo plano
schtasks /create /tn "%NOME_TAREFA%" /tr "wscript.exe \"%PASTA_MIX%\run_silent.vbs\"" /sc minute /mo 5 /ru "%USERNAME%" /rl HIGHEST /f
set "RESULTADO_TAREFA=%errorLevel%"

:: Reativa tambem as tarefas nativas criadas pelo Integrador.
schtasks /change /tn "\MixFiscalIntegrador\BootStart" /enable >nul 2>&1
schtasks /change /tn "\MixFiscalIntegrador\Startup" /enable >nul 2>&1
schtasks /change /tn "\MixFiscalIntegrador\Watchdog" /enable >nul 2>&1

if %RESULTADO_TAREFA% equ 0 (
    echo.
    echo SUCESSO! Monitoramento ativado para o caminho:
    echo %PASTA_MIX%
    echo.
    echo As verificacoes serao 100%% INVISIVEIS, sem piscar tela.
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
    echo Executavel disparado com sucesso.
) else (
    echo ERRO: Arquivo nao encontrado em: %PASTA_MIX%\%NOME_EXE%
)
echo.
pause
goto MENU

:PARAR
cls
echo Encerrando processos do Integrador e WebView2...
taskkill /f /im "%NOME_EXE%" >nul 2>&1
taskkill /f /im msedgewebview2.exe >nul 2>&1
echo Processos encerrados.
echo.
pause
goto MENU

:DESINSTALAR
cls
schtasks /end /tn "%NOME_TAREFA%" >nul 2>&1
schtasks /delete /tn "%NOME_TAREFA%" /f >nul 2>&1
schtasks /change /tn "\MixFiscalIntegrador\BootStart" /disable >nul 2>&1
schtasks /change /tn "\MixFiscalIntegrador\Startup" /disable >nul 2>&1
schtasks /change /tn "\MixFiscalIntegrador\Watchdog" /disable >nul 2>&1
if exist "%PASTA_MIX%\run_silent.vbs" del /f /q "%PASTA_MIX%\run_silent.vbs"
echo Monitoramento extra e tarefas nativas desativados.
echo Agora use a opcao 4 para parar o Integrador antes da manutencao.
echo.
if /I "%~1"=="--stop-monitor" exit /b 0
pause
goto MENU

:STATUS
cls
echo ==============================================================================
echo                      STATUS DO PROCESSO E MONITOR
echo ==============================================================================
echo.
echo [VERSAO] %VERSAO_INSTALADA%
tasklist /fi "IMAGENAME eq %NOME_EXE%" 2>NUL | findstr /I "%NOME_EXE%" >nul
if %errorlevel% equ 0 (
    echo [RODANDO] O %NOME_EXE% esta em execucao.
) else (
    echo [PARADO] O %NOME_EXE% NAO esta rodando no momento.
)

schtasks /query /tn "%NOME_TAREFA%" >nul 2>&1
if %errorlevel% equ 0 (
    echo [ATIVO] O Monitor do Windows esta instalado.
) else (
    echo [INATIVO] O Monitor do Windows nao esta instalado.
)
echo.
pause
goto MENU
