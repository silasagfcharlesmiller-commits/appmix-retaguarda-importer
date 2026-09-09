param([switch]$SkipDependencies)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path (Split-Path -Parent $root) '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }

if (-not $SkipDependencies) {
    & $python -m pip install -r (Join-Path $root 'requirements-instalador.txt')
}
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
    --add-data ((Join-Path $root 'integrador_version.json') + ';.') `
    --paths $root `
    --collect-all playwright `
    --specpath $root `
    --distpath (Join-Path $root 'entrega') `
    --workpath (Join-Path $root 'build') `
    (Join-Path $root 'instalador_gui.py')

Write-Host "Instalador criado em: $(Join-Path $root 'entrega\Instalador-Mix-Fiscal.exe')"
