param(
    [ValidateSet("interface", "worker")]
    [string]$Modo = "interface",
    [switch]$SomenteInstalar
)

$ErrorActionPreference = "Stop"
$PastaAppMix = Split-Path -Parent $MyInvocation.MyCommand.Path
$PastaVenv = Join-Path $PastaAppMix ".venv"
$PythonVenv = Join-Path $PastaVenv "Scripts\python.exe"
$Requirements = Join-Path $PastaAppMix "requirements.txt"
$ArquivoHash = Join-Path $PastaVenv ".requirements.sha256"

Set-Location $PastaAppMix

# Ambientes virtuais do Windows nao sao portateis. Um venv copiado pode ainda
# apontar para o Python da outra maquina, portanto ele deve ser validado.
if (Test-Path -LiteralPath $PythonVenv) {
    $VenvValido = $false
    try {
        & $PythonVenv -c "import sys; raise SystemExit(0 if sys.prefix != sys.base_prefix else 1)" 2>$null
        $VenvValido = ($LASTEXITCODE -eq 0)
    } catch {
        $VenvValido = $false
    }
    if (-not $VenvValido) {
        Write-Host "Ambiente de outra maquina ou corrompido. Recriando..." -ForegroundColor Yellow
        Remove-Item -LiteralPath $PastaVenv -Recurse -Force
    }
}

if (-not (Test-Path -LiteralPath $PythonVenv)) {
    Write-Host "[1/3] Criando ambiente virtual local..." -ForegroundColor Cyan
    $CriadorVenv = $null
    if (Get-Command python -ErrorAction SilentlyContinue) {
        try {
            & python -c "import sys" 2>$null
            if ($LASTEXITCODE -eq 0) { $CriadorVenv = "python" }
        } catch { }
    }
    if (-not $CriadorVenv -and (Get-Command py -ErrorAction SilentlyContinue)) {
        try {
            & py -3 -c "import sys" 2>$null
            if ($LASTEXITCODE -eq 0) { $CriadorVenv = "py" }
        } catch { }
    }

    if ($CriadorVenv -eq "python") {
        & python -m venv $PastaVenv
    } elseif ($CriadorVenv -eq "py") {
        & py -3 -m venv $PastaVenv
    } else {
        throw "Python 3 não encontrado. Instale o Python 3.11 ou superior."
    }

    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $PythonVenv)) {
        throw "Falha ao criar o ambiente virtual local."
    }
}

$HashAtual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Requirements).Hash
$HashInstalado = if (Test-Path -LiteralPath $ArquivoHash) {
    (Get-Content -Raw -LiteralPath $ArquivoHash).Trim()
} else { "" }

if ($HashAtual -ne $HashInstalado) {
    Write-Host "[2/3] Instalando/atualizando bibliotecas..." -ForegroundColor Cyan
    & $PythonVenv -m pip install --upgrade pip
    & $PythonVenv -m pip install -r $Requirements
    if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar requirements.txt." }
    Set-Content -LiteralPath $ArquivoHash -Value $HashAtual -Encoding ASCII
} else {
    Write-Host "[2/3] Bibliotecas já instaladas." -ForegroundColor Green
}

if ($SomenteInstalar) {
    Write-Host "[3/3] Ambiente pronto para API e compilação." -ForegroundColor Green
    exit 0
}

if ($Modo -eq "worker") {
    Write-Host "[3/3] Iniciando worker via API..." -ForegroundColor Cyan
    & $PythonVenv (Join-Path $PastaAppMix "worker_mix.py")
} else {
    Write-Host "[3/3] Iniciando interface App Mix..." -ForegroundColor Cyan
    & $PythonVenv (Join-Path $PastaAppMix "appmix.pyw")
}
