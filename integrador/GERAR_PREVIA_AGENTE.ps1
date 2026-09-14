param([switch]$SkipDependencies)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$output = Join-Path $root 'entrega-agente'

& (Join-Path $root 'GERAR_INSTALADOR.ps1') `
    -SkipDependencies:$SkipDependencies `
    -OutputDirectory $output `
    -OutputBaseName 'Instalador-Mix-Fiscal-Agente-Preview'

if ($LASTEXITCODE -ne 0) {
    throw 'A previa isolada do instalador com Mix Agent nao foi gerada.'
}

Write-Host 'Previa isolada criada. Este arquivo depende da API da branch e nao deve ser usado em producao.'
