param([switch]$SkipDependencies)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path (Split-Path -Parent $root) '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }

if (-not $SkipDependencies) {
    & $python -m pip install -r (Join-Path $root 'requirements-instalador.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependencias do setup.' }
}

$versionData = Get-Content -LiteralPath (Join-Path $root 'integrador_version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$versionData.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Versao do Integrador invalida.' }

$buildRoot = Join-Path $root 'build'
$runtimeDist = Join-Path $buildRoot 'installer-runtime'
$runtimeDir = Join-Path $runtimeDist 'Instalador-Mix-Fiscal-App'
$payloadManifest = Join-Path $buildRoot 'payload_manifest.json'
$installer = Join-Path $root 'entrega\Instalador-Mix-Fiscal.exe'

$resolvedRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
$resolvedRuntime = [System.IO.Path]::GetFullPath($runtimeDist)
if (-not $resolvedRuntime.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Pasta de build fora da raiz do Integrador.'
}
if (Test-Path -LiteralPath $runtimeDist) {
    Remove-Item -LiteralPath $runtimeDist -Recurse -Force
}
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $installer) -Force | Out-Null

$componentNames = @(
    'desktop-integrador.exe', 'Painel_Mix.bat', 'atualizador_mix.ps1',
    'monitor_mix.ps1', 'run_silent.vbs', 'integrador_version.json'
)
$payload = [ordered]@{ version = $version; files = [ordered]@{} }
foreach ($name in $componentNames) {
    $source = Join-Path $root $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Componente obrigatorio ausente: $name"
    }
    $payload.files[$name] = [ordered]@{
        size = (Get-Item -LiteralPath $source).Length
        sha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToUpperInvariant()
    }
}
[System.IO.File]::WriteAllText(
    $payloadManifest,
    ($payload | ConvertTo-Json -Depth 5),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host 'Gerando aplicacao interna sem extracao onefile e sem Playwright/Node...'
& $python -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --windowed `
    --uac-admin `
    --name 'Instalador-Mix-Fiscal-App' `
    --icon ((Join-Path $root 'desktop-integrador.exe') + ',0') `
    --add-data ($payloadManifest + ';.') `
    --add-data ((Join-Path $root 'integrador_version.json') + ';.') `
    --paths $root `
    --specpath $root `
    --distpath $runtimeDist `
    --workpath (Join-Path $buildRoot 'installer-runtime-work') `
    (Join-Path $root 'instalador_gui.py')
if ($LASTEXITCODE -ne 0) { throw 'Falha ao gerar a aplicacao interna do setup.' }

$isccCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
)
$iscc = $isccCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $iscc) {
    throw 'Inno Setup 6 nao encontrado. Instale JRSoftware.InnoSetup pelo winget.'
}

$env:MIX_SETUP_VERSION = $version
$env:MIX_SETUP_RUNTIME = $runtimeDir
$env:MIX_SETUP_SOURCE = $root
$env:MIX_SETUP_OUTPUT = Split-Path -Parent $installer
try {
    & $iscc (Join-Path $root 'Instalador-Mix-Fiscal.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar o pacote Inno Setup.' }
} finally {
    Remove-Item Env:MIX_SETUP_VERSION,Env:MIX_SETUP_RUNTIME,Env:MIX_SETUP_SOURCE,Env:MIX_SETUP_OUTPUT -ErrorAction SilentlyContinue
}

& $python (Join-Path $root 'verificar_pacote.py') $installer $runtimeDir $payloadManifest
if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    throw 'O pacote final nao passou na verificacao de integridade.'
}
Write-Host "Instalador convencional criado e validado em: $installer"
