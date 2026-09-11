param([switch]$SkipDependencies)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Split-Path -Parent $root
$python = Join-Path $project '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }

$portableGo = Join-Path $root '.tools\go1.26.4\go\bin\go.exe'
if (Test-Path -LiteralPath $portableGo -PathType Leaf) {
    $go = $portableGo
} else {
    $goCommand = Get-Command go -ErrorAction SilentlyContinue
    if (-not $goCommand) {
        throw 'Go 1.26.4 nao encontrado. Instale o Go ou extraia o pacote oficial em integrador\.tools\go1.26.4.'
    }
    $go = $goCommand.Source
}

$versionData = Get-Content -LiteralPath (Join-Path $root 'integrador_version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$versionData.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Versao do Integrador invalida.' }

$buildRoot = Join-Path $root 'build'
$runtimeDist = Join-Path $buildRoot 'installer-runtime'
$runtimeDir = Join-Path $runtimeDist 'Instalador-Mix-Fiscal-App'
$payloadManifest = Join-Path $buildRoot 'payload_manifest.json'
$installer = Join-Path $root 'entrega\Instalador-Mix-Fiscal.exe'
$goProject = Join-Path $root 'go-installer'

$resolvedRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
$resolvedRuntime = [System.IO.Path]::GetFullPath($runtimeDist)
if (-not $resolvedRuntime.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Pasta de build fora da raiz do Integrador.'
}
if (Test-Path -LiteralPath $runtimeDist) {
    Remove-Item -LiteralPath $runtimeDist -Recurse -Force
}
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
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
Copy-Item -LiteralPath $payloadManifest -Destination (Join-Path $runtimeDir 'payload_manifest.json') -Force

$goCache = New-Item -ItemType Directory -Path (Join-Path $root '.tools\gocache') -Force
$goModuleCache = New-Item -ItemType Directory -Path (Join-Path $root '.tools\gomodcache') -Force
$previousGoCache = $env:GOCACHE
$previousGoModuleCache = $env:GOMODCACHE
$previousCGO = $env:CGO_ENABLED
$env:GOCACHE = $goCache.FullName
$env:GOMODCACHE = $goModuleCache.FullName
$env:CGO_ENABLED = '0'

Write-Host 'Gerando bootstrap e interface nativos em Go/Wails, sem Python, PyQt, Playwright ou Node...'
Push-Location $goProject
try {
    if (-not $SkipDependencies) {
        & $go mod download
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar os modulos Go do instalador.' }
    }
    & $go test ./...
    if ($LASTEXITCODE -ne 0) { throw 'Os testes Go do instalador falharam.' }

    & $go build -buildvcs=false -trimpath -ldflags '-s -w -H windowsgui' `
        -o (Join-Path $runtimeDir 'MixFiscal-Bootstrap.exe') .\cmd\bootstrap
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao gerar o bootstrap do WebView2.' }

    $uiLdFlags = "-s -w -H windowsgui -X main.version=$version"
    & $go build -buildvcs=false -tags 'desktop,production,wv2runtime.download' -trimpath `
        -ldflags $uiLdFlags -o (Join-Path $runtimeDir 'Instalador-Mix-Fiscal-App.exe') .\cmd\ui
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao gerar a interface Go/Wails.' }
} finally {
    Pop-Location
    $env:GOCACHE = $previousGoCache
    $env:GOMODCACHE = $previousGoModuleCache
    $env:CGO_ENABLED = $previousCGO
}

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
Write-Host "Instalador Go/Wails criado e validado em: $installer"
