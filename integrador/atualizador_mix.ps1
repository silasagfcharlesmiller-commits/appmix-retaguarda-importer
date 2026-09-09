$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$manifestUrl = 'https://appmix-retaguarda-importer.vercel.app/integrador-updates/version.json'
$expectedHost = 'appmix-retaguarda-importer.vercel.app'
$work = $PSScriptRoot
$versionFile = Join-Path $work 'integrador_version.json'
$logFile = Join-Path $work 'atualizador_log.txt'
$updateDir = Join-Path $work '.update'

function Write-UpdateLog([string]$message) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $logFile -Value "[$stamp] $message" -Encoding UTF8
}

function Find-IntegratorExe {
    $preferred = Join-Path $work 'desktop-integrador.exe'
    if (Test-Path -LiteralPath $preferred) { return $preferred }

    $candidate = Get-ChildItem -LiteralPath $work -File -Filter '*integrador*.exe' |
        Where-Object { $_.Name -notlike 'Instalador*' } |
        Select-Object -First 1
    if ($candidate) { return $candidate.FullName }

    $allExe = @(Get-ChildItem -LiteralPath $work -File -Filter '*.exe' |
        Where-Object { $_.Name -notlike 'Instalador*' })
    if ($allExe.Count -eq 1) { return $allExe[0].FullName }
    return $null
}

$mutex = New-Object System.Threading.Mutex($false, 'Global\MixFiscalIntegradorUpdater')
$locked = $false
try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { return }

    $localVersion = [version]'0.0.0'
    if (Test-Path -LiteralPath $versionFile) {
        $localData = Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $localVersion = [version]([string]$localData.version)
    }

    $cacheBuster = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $manifestResponse = Invoke-RestMethod -Uri "$manifestUrl?t=$cacheBuster" -Method Get -TimeoutSec 30
    if ($manifestResponse -is [string]) {
        $manifest = $manifestResponse.TrimStart([char]0xFEFF) | ConvertFrom-Json
    } else {
        $manifest = $manifestResponse
    }
    $remoteVersion = [version]([string]$manifest.version)
    if ($remoteVersion -le $localVersion) { return }

    $downloadUri = [uri]([string]$manifest.executable.url)
    $expectedHash = ([string]$manifest.executable.sha256).Trim().ToUpperInvariant()
    $expectedSize = [int64]$manifest.executable.size
    if ($downloadUri.Scheme -ne 'https' -or $downloadUri.Host -ne $expectedHost) {
        throw 'O manifesto retornou uma origem de download nao autorizada.'
    }
    if ($expectedHash -notmatch '^[A-F0-9]{64}$' -or $expectedSize -le 0) {
        throw 'O manifesto de atualizacao esta incompleto.'
    }

    $target = Find-IntegratorExe
    if (-not $target) { throw 'O executavel do Integrador nao foi encontrado nesta pasta.' }

    New-Item -ItemType Directory -Path $updateDir -Force | Out-Null
    $download = Join-Path $updateDir 'desktop-integrador.exe.download'
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $downloadUri.AbsoluteUri -OutFile $download -UseBasicParsing -TimeoutSec 300

    $downloadInfo = Get-Item -LiteralPath $download
    if ($downloadInfo.Length -ne $expectedSize) {
        throw "Tamanho da atualizacao invalido: $($downloadInfo.Length)."
    }
    $actualHash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actualHash -ne $expectedHash) {
        throw 'SHA-256 da atualizacao nao confere.'
    }

    $header = New-Object byte[] 2
    $stream = [System.IO.File]::OpenRead($download)
    try { $headerLength = $stream.Read($header, 0, 2) } finally { $stream.Dispose() }
    if ($headerLength -ne 2 -or $header[0] -ne 0x4D -or $header[1] -ne 0x5A) {
        throw 'O arquivo baixado nao e um executavel Windows valido.'
    }

    $targetName = [System.IO.Path]::GetFileName($target)
    Get-CimInstance Win32_Process -Filter "Name='$targetName'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $target } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800

    $backup = "$target.bak"
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    try {
        [System.IO.File]::Replace($download, $target, $backup, $true)
        $versionTemp = "$versionFile.tmp"
        $versionJson = @{
            version = [string]$manifest.version
            channel = [string]$manifest.channel
            installed_at = [DateTimeOffset]::UtcNow.ToString('o')
            sha256 = $actualHash
        } | ConvertTo-Json
        [System.IO.File]::WriteAllText(
            $versionTemp, $versionJson, [System.Text.UTF8Encoding]::new($false)
        )
        if (Test-Path -LiteralPath $versionFile) {
            [System.IO.File]::Replace($versionTemp, $versionFile, $null, $true)
        } else {
            Move-Item -LiteralPath $versionTemp -Destination $versionFile
        }
        Start-Process -FilePath $target -WorkingDirectory $work
        Write-UpdateLog "Atualizado de $localVersion para $remoteVersion."
    } catch {
        Copy-Item -LiteralPath $backup -Destination $target -Force
        Start-Process -FilePath $target -WorkingDirectory $work
        throw
    }
} catch {
    Write-UpdateLog "Falha na verificacao/atualizacao: $($_.Exception.Message)"
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
