param(
    [string]$Destino = "pacote_teste"
)

$ErrorActionPreference = "Stop"
$PastaOrigem = Split-Path -Parent $MyInvocation.MyCommand.Path
$PastaDestino = if ([System.IO.Path]::IsPathRooted($Destino)) {
    $Destino
} else {
    Join-Path $PastaOrigem $Destino
}

$ArquivosObrigatorios = @(
    "appmix.pyw",
    "worker_mix.py",
    "automacao_api.py",
    "api_mix.py",
    "automacao_core.py",
    "automacao_login.py",
    "automacao_tabela.py",
    "automacao_compara_divergencia.py",
    "comparar_divergencia_widget.py",
    "database.py",
    "mapeamento_portal_mix.json",
    "mapeamento_configuracoes.json",
    "requirements.txt",
    "primeira_execucao.ps1",
    "INSTALAR_LIMPO.bat",
    "INICIAR_API.bat",
    "INICIAR_WORKER_API.bat",
    "config_mix.json"
)

$ArquivosOpcionais = @(
    "cache_modais.json",
    "README.md",
    "MANUAL_INSTALACAO.md",
    "MANUAL_EMANUEL.md",
    "API_DOCUMENTACAO.md",
    "preparar_pasta_teste.ps1"
)

$Ausentes = $ArquivosObrigatorios | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $PastaOrigem $_))
}
if ($Ausentes.Count -gt 0) {
    throw "Arquivos obrigatórios ausentes: $($Ausentes -join ', ')"
}

if (Test-Path -LiteralPath $PastaDestino) {
    $ConteudoExistente = Get-ChildItem -LiteralPath $PastaDestino -Force -ErrorAction SilentlyContinue
    if ($ConteudoExistente.Count -gt 0) {
        throw "A pasta de destino já existe e não está vazia: $PastaDestino"
    }
} else {
    New-Item -ItemType Directory -Path $PastaDestino | Out-Null
}

foreach ($Arquivo in $ArquivosObrigatorios) {
    Copy-Item -LiteralPath (Join-Path $PastaOrigem $Arquivo) -Destination $PastaDestino
}
foreach ($Arquivo in $ArquivosOpcionais) {
    $OrigemOpcional = Join-Path $PastaOrigem $Arquivo
    if (Test-Path -LiteralPath $OrigemOpcional) {
        Copy-Item -LiteralPath $OrigemOpcional -Destination $PastaDestino
    }
}

Write-Host "Pasta de teste preparada em:" -ForegroundColor Green
Write-Host $PastaDestino
Write-Warning "config_mix.json foi incluído e contém credenciais. Proteja esta pasta."
Write-Host "Na máquina nova, execute:" -ForegroundColor Cyan
Write-Host "powershell -ExecutionPolicy Bypass -File .\primeira_execucao.ps1 -Modo interface"
