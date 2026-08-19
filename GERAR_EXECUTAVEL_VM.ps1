param(
    [string]$Destino = "pacote_vm"
)

$ErrorActionPreference = "Stop"
$PastaProjeto = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonVenv = Join-Path $PastaProjeto ".venv\Scripts\python.exe"
$PastaDestino = Join-Path $PastaProjeto $Destino
$PastaBuild = Join-Path $PastaProjeto "build_api"

Set-Location $PastaProjeto

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
    (Join-Path $PastaProjeto "primeira_execucao.ps1") -SomenteInstalar
if ($LASTEXITCODE -ne 0) {
    throw "Nao foi possivel preparar as dependencias."
}

if (-not (Test-Path -LiteralPath $PastaDestino)) {
    New-Item -ItemType Directory -Path $PastaDestino | Out-Null
}

Write-Host "Compilando APP-MIX para a VM..." -ForegroundColor Cyan
& $PythonVenv -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name "APP-MIX" `
    --distpath $PastaDestino `
    --workpath $PastaBuild `
    --specpath $PastaBuild `
    --add-data "$PastaProjeto\mapeamento_portal_mix.json;." `
    --add-data "$PastaProjeto\mapeamento_configuracoes.json;." `
    (Join-Path $PastaProjeto "appmix.pyw")
if ($LASTEXITCODE -ne 0) {
    throw "Falha ao gerar o executavel da interface."
}

Write-Host "Compilando API de integracao..." -ForegroundColor Cyan
& $PythonVenv -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --console `
    --name "APP-MIX-API" `
    --distpath $PastaDestino `
    --workpath (Join-Path $PastaBuild "api") `
    --specpath $PastaBuild `
    (Join-Path $PastaProjeto "api_mix.py")
if ($LASTEXITCODE -ne 0) {
    throw "Falha ao gerar o executavel da API."
}

Write-Host "Compilando worker da fila..." -ForegroundColor Cyan
& $PythonVenv -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --console `
    --name "APP-MIX-WORKER" `
    --distpath $PastaDestino `
    --workpath (Join-Path $PastaBuild "worker") `
    --specpath $PastaBuild `
    (Join-Path $PastaProjeto "worker_mix.py")
if ($LASTEXITCODE -ne 0) {
    throw "Falha ao gerar o executavel do worker."
}

foreach ($Arquivo in @(
    "config_mix.json",
    "mapeamento_portal_mix.json",
    "mapeamento_configuracoes.json",
    "API_DOCUMENTACAO.md"
)) {
    Copy-Item -LiteralPath (Join-Path $PastaProjeto $Arquivo) `
        -Destination $PastaDestino -Force
}

@"
APP-MIX - PACOTE PARA VM

1. Copie esta pasta inteira para a VM Windows.
2. Proteja config_mix.json: ele possui a conexao do banco.
3. Abra APP-MIX-WORKER.exe e deixe-o em execucao.
4. Abra APP-MIX-API.exe para aceitar integracoes na porta configurada.
5. Abra APP-MIX.exe para uso humano da interface.
6. Na primeira abertura da API, consulte a chave criada em config_api.json.
7. Python, pip e Chromium nao sao necessarios na VM.
8. A VM precisa acessar o PostgreSQL e as APIs HTTPS da Mix Fiscal.
"@ | Set-Content -LiteralPath (Join-Path $PastaDestino "LEIA-ME-VM.txt") -Encoding UTF8

Write-Host "Pacote pronto em: $PastaDestino" -ForegroundColor Green
Write-Warning "O pacote inclui config_mix.json. Restrinja as permissoes da pasta."
