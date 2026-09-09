param([switch]$SkipDependencies)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path (Split-Path -Parent $root) '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }

if (-not $SkipDependencies) {
    & $python -m pip install -r (Join-Path $root 'requirements-instalador.txt')
}
$installer = Join-Path $root 'entrega\Instalador-Mix-Fiscal.exe'
$valid = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
    Write-Host "Gerando instalador (tentativa $attempt de 3)..."
    & $python -m PyInstaller `
        --noconfirm `
        --clean `
        --onefile `
        --windowed `
        --uac-admin `
        --name 'Instalador-Mix-Fiscal' `
        --icon ((Join-Path $root 'desktop-integrador.exe') + ',0') `
        --add-binary ((Join-Path $root 'desktop-integrador.exe') + ';.') `
        --add-data ((Join-Path $root 'Painel_Mix.bat') + ';.') `
        --add-data ((Join-Path $root 'atualizador_mix.ps1') + ';.') `
        --add-data ((Join-Path $root 'monitor_mix.ps1') + ';.') `
        --add-data ((Join-Path $root 'run_silent.vbs') + ';.') `
        --add-data ((Join-Path $root 'integrador_version.json') + ';.') `
        --paths $root `
        --collect-all playwright `
        --specpath $root `
        --distpath (Join-Path $root 'entrega') `
        --workpath (Join-Path $root 'build') `
        (Join-Path $root 'instalador_gui.py')

    if ($LASTEXITCODE -eq 0) {
        & $python (Join-Path $root 'verificar_pacote.py') $installer
        if ($LASTEXITCODE -eq 0) {
            $valid = $true
            break
        }
    }

    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    if ($attempt -lt 3) {
        Write-Warning 'Pacote invalido; o build sera repetido.'
    }
}

if (-not $valid) {
    throw 'Nao foi possivel gerar um pacote integro em tres tentativas.'
}
Write-Host "Instalador criado e validado em: $installer"
