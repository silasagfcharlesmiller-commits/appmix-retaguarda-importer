param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Versao,

    [Parameter(Mandatory = $true)]
    [string]$Executavel
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Split-Path -Parent $root
$sourceExe = (Resolve-Path -LiteralPath $Executavel).Path
$integratorExe = Join-Path $root 'desktop-integrador.exe'
$publicUpdate = Join-Path $project 'web\public\integrador-updates'
$publicDownload = Join-Path $project 'web\public\downloads'

New-Item -ItemType Directory -Path $publicUpdate -Force | Out-Null
New-Item -ItemType Directory -Path $publicDownload -Force | Out-Null
if ($sourceExe -ne $integratorExe) {
    Copy-Item -LiteralPath $sourceExe -Destination $integratorExe -Force
}
Copy-Item -LiteralPath $sourceExe -Destination (Join-Path $publicUpdate 'desktop-integrador.exe') -Force

$hash = (Get-FileHash -LiteralPath $integratorExe -Algorithm SHA256).Hash.ToUpperInvariant()
$size = (Get-Item -LiteralPath $integratorExe).Length
$manifest = [ordered]@{
    schema = 1
    version = $Versao
    channel = 'stable'
    published_at = [DateTimeOffset]::UtcNow.ToString('o')
    executable = [ordered]@{
        url = "https://appmix-retaguarda-importer.vercel.app/integrador-updates/desktop-integrador.exe?v=$Versao"
        sha256 = $hash
        size = $size
    }
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $publicUpdate 'version.json') -Encoding UTF8
@{version = $Versao; channel = 'stable'} | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $root 'integrador_version.json') -Encoding UTF8

& (Join-Path $root 'GERAR_INSTALADOR.ps1') -SkipDependencies
Copy-Item -LiteralPath (Join-Path $root 'entrega\Instalador-Mix-Fiscal.exe') `
    -Destination (Join-Path $publicDownload 'Instalador-Mix-Fiscal.exe') -Force

Write-Host "Versao $Versao preparada."
Write-Host "SHA-256 do Integrador: $hash"
Write-Host 'Revise os arquivos, confirme o build do site e publique o commit.'
