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

$componentNames = @(
    'desktop-integrador.exe',
    'Painel_Mix.bat',
    'monitor_mix.ps1',
    'run_silent.vbs',
    'atualizador_mix.ps1'
)
$components = @()
foreach ($name in $componentNames) {
    $source = Join-Path $root $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Componente obrigatorio nao encontrado: $name"
    }
    $destination = Join-Path $publicUpdate $name
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $components += [ordered]@{
        name = $name
        url = "https://appmix-retaguarda-importer.vercel.app/integrador-updates/${name}?v=$Versao"
        sha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToUpperInvariant()
        size = (Get-Item -LiteralPath $source).Length
    }
}

$executable = $components | Where-Object { $_.name -eq 'desktop-integrador.exe' }
$manifest = [ordered]@{
    schema = 2
    version = $Versao
    channel = 'stable'
    published_at = [DateTimeOffset]::UtcNow.ToString('o')
    executable = [ordered]@{
        url = $executable.url
        sha256 = $executable.sha256
        size = $executable.size
    }
    files = $components
}
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$manifestJson = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText(
    (Join-Path $publicUpdate 'version.json'), $manifestJson, $utf8NoBom
)
$localVersionJson = @{version = $Versao; channel = 'stable'} | ConvertTo-Json
[System.IO.File]::WriteAllText(
    (Join-Path $root 'integrador_version.json'), $localVersionJson, $utf8NoBom
)

& (Join-Path $root 'GERAR_INSTALADOR.ps1') -SkipDependencies
$installerSource = Join-Path $root 'entrega\Instalador-Mix-Fiscal.exe'
$installerPublic = Join-Path $publicDownload 'Instalador-Mix-Fiscal.exe'
Copy-Item -LiteralPath $installerSource -Destination $installerPublic -Force

# O manifesto do setup é incluído após o build para permitir atualização automática
# do próprio instalador sem criar dependência circular no arquivo empacotado.
$manifest['installer'] = [ordered]@{
    url = "https://appmix-retaguarda-importer.vercel.app/downloads/Instalador-Mix-Fiscal.exe?v=$Versao"
    sha256 = (Get-FileHash -LiteralPath $installerSource -Algorithm SHA256).Hash.ToUpperInvariant()
    size = (Get-Item -LiteralPath $installerSource).Length
}
$manifestJson = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText(
    (Join-Path $publicUpdate 'version.json'), $manifestJson, $utf8NoBom
)

Write-Host "Versao $Versao preparada."
Write-Host "SHA-256 do Integrador: $($executable.sha256)"
Write-Host "Componentes publicados: $($components.Count)"
Write-Host "SHA-256 do Instalador: $($manifest['installer'].sha256)"
Write-Host 'Revise os arquivos, confirme o build do site e publique o commit.'
