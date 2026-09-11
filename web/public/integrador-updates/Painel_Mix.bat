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
set "TAREFA_BOOT=\MixFiscalIntegrador\BootStart"
set "TAREFA_STARTUP=\MixFiscalIntegrador\Startup"
set "TAREFA_WATCHDOG=\MixFiscalIntegrador\Watchdog"

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

:GERAR_LANCADOR
:: A opcao 5 remove este arquivo. A opcao 2 sempre o recria para permitir
:: instalar novamente o monitor sem precisar executar o setup outra vez.
> "%PASTA_MIX%\run_silent.vbs" echo Set shell = CreateObject("WScript.Shell"^)
>> "%PASTA_MIX%\run_silent.vbs" echo Set fileSystem = CreateObject("Scripting.FileSystemObject"^)
>> "%PASTA_MIX%\run_silent.vbs" echo folder = fileSystem.GetParentFolderName(WScript.ScriptFullName^)
>> "%PASTA_MIX%\run_silent.vbs" echo command = "powershell.exe -ExecutionPolicy Bypass -NoProfile -File """ ^& folder ^& "\monitor_mix.ps1"""
>> "%PASTA_MIX%\run_silent.vbs" echo shell.Run command, 0, False
if not exist "%PASTA_MIX%\run_silent.vbs" exit /b 2
exit /b 0

:INSTALAR
cls
echo ============================================================================
echo              INSTALANDO / ATIVANDO MONITORAMENTO AUTOMATICO
echo ============================================================================
echo.
echo [1/2] Validando os componentes em: %PASTA_MIX%...
call :GERAR_LANCADOR
if errorlevel 1 (
    echo ERRO: nao foi possivel criar run_silent.vbs em %PASTA_MIX%.
    if /I "%~1"=="--install-monitor" exit /b 2
    echo.
    pause
    goto MENU
)
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
:: A conta ja foi validada pelo setup. /IT usa o token da sessao conectada e
:: evita pedir uma senha invisivel dentro do instalador.
call schtasks /create /tn "%NOME_TAREFA%" /tr "wscript.exe \"%PASTA_MIX%\run_silent.vbs\"" /sc minute /mo 5 /it /rl HIGHEST /f
set "RESULTADO_TAREFA=%errorLevel%"

:: Reativa as tarefas nativas que o Integrador possa ter criado.
call schtasks /change /tn "%TAREFA_BOOT%" /enable >nul 2>&1
call schtasks /change /tn "%TAREFA_STARTUP%" /enable >nul 2>&1
call schtasks /change /tn "%TAREFA_WATCHDOG%" /enable >nul 2>&1

if %RESULTADO_TAREFA% equ 0 (
    echo.
    echo SUCESSO: Monitoramento ativado para:
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
echo ============================================================================
echo               DESINSTALANDO O MONITORAMENTO AUTOMATICO
echo ============================================================================
echo.
set "FALHAS_LIMPEZA=0"

call :REMOVER_TAREFA "%NOME_TAREFA%"
if errorlevel 1 set /a FALHAS_LIMPEZA+=1
call :REMOVER_TAREFA "%NOME_TAREFA_ANTIGA%"
if errorlevel 1 set /a FALHAS_LIMPEZA+=1

:: Estas tarefas pertencem ao Integrador. Mantemos as definicoes para que a
:: opcao 2 consiga reativa-las sem precisar reinstalar o aplicativo.
call schtasks /change /tn "%TAREFA_BOOT%" /disable >nul 2>&1
call schtasks /change /tn "%TAREFA_STARTUP%" /disable >nul 2>&1
call schtasks /change /tn "%TAREFA_WATCHDOG%" /disable >nul 2>&1

call :REMOVER_ARQUIVO "%PASTA_MIX%\run_silent.vbs"
if errorlevel 1 set /a FALHAS_LIMPEZA+=1

echo.
if "!FALHAS_LIMPEZA!"=="0" (
    echo SUCESSO: Tarefas do monitor e arquivo VBS foram removidos.
    echo As tarefas nativas do Integrador foram desativadas para manutencao.
) else (
    echo ATENCAO: !FALHAS_LIMPEZA! item^(ns^) nao puderam ser removidos.
    echo Execute novamente como administrador e confira as mensagens acima.
)
echo A opcao 2 pode recriar o VBS e instalar o monitor novamente.
echo.
if /I "%~1"=="--stop-monitor" exit /b !FALHAS_LIMPEZA!
pause
goto MENU

:REMOVER_TAREFA
call schtasks /query /tn "%~1" >nul 2>&1
if errorlevel 1 (
    echo [OK] Tarefa ja estava ausente: %~1
    exit /b 0
)
call schtasks /end /tn "%~1" >nul 2>&1
call schtasks /delete /tn "%~1" /f >nul 2>&1
call schtasks /query /tn "%~1" >nul 2>&1
if not errorlevel 1 (
    echo [ERRO] A tarefa continua no Agendador: %~1
    exit /b 1
)
echo [OK] Tarefa excluida: %~1
exit /b 0

:REMOVER_ARQUIVO
if not exist "%~1" (
    echo [OK] Arquivo VBS ja estava ausente: %~nx1
    exit /b 0
)
del /f /q "%~1" >nul 2>&1
if exist "%~1" (
    echo [ERRO] Nao foi possivel excluir: %~1
    exit /b 1
)
echo [OK] Arquivo VBS excluido: %~nx1
exit /b 0

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
