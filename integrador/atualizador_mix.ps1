$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$manifestUrl = 'https://appmix-retaguarda-importer.vercel.app/integrador-updates/version.json'
$expectedHost = 'appmix-retaguarda-importer.vercel.app'
$work = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$versionFile = Join-Path $work 'integrador_version.json'
$logFile = Join-Path $work 'atualizador_log.txt'
$updateDir = Join-Path $work '.update'
$allowedFiles = @(
    'desktop-integrador.exe',
    'Painel_Mix.bat',
    'monitor_mix.ps1',
    'run_silent.vbs',
    'atualizador_mix.ps1'
)

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

function Get-ManifestFiles($manifest) {
    if ($manifest.files) { return @($manifest.files) }
    return @([pscustomobject]@{
        name = 'desktop-integrador.exe'
        url = [string]$manifest.executable.url
        sha256 = [string]$manifest.executable.sha256
        size = [int64]$manifest.executable.size
    })
}

function Download-UpdateFile($entry) {
    $name = [string]$entry.name
    if ($allowedFiles -notcontains $name) {
        throw "Componente nao autorizado no manifesto: $name"
    }
    $downloadUri = [uri]([string]$entry.url)
    $expectedHash = ([string]$entry.sha256).Trim().ToUpperInvariant()
    $expectedSize = [int64]$entry.size
    if ($downloadUri.Scheme -ne 'https' -or $downloadUri.Host -ne $expectedHost) {
        throw "Origem nao autorizada para $name."
    }
    if ($expectedHash -notmatch '^[A-F0-9]{64}$' -or $expectedSize -le 0) {
        throw "Metadados incompletos para $name."
    }

    $destination = Join-Path $work $name
    if ($name -eq 'desktop-integrador.exe') {
        $detected = Find-IntegratorExe
        if ($detected) { $destination = $detected }
    }
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $current = Get-Item -LiteralPath $destination
        if ($current.Length -eq $expectedSize) {
            $currentHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToUpperInvariant()
            if ($currentHash -eq $expectedHash) { return $null }
        }
    }

    $download = Join-Path $updateDir ($name + '.download')
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $downloadUri.AbsoluteUri -OutFile $download -UseBasicParsing -TimeoutSec 300
    $downloadInfo = Get-Item -LiteralPath $download
    if ($downloadInfo.Length -ne $expectedSize) {
        throw "Tamanho invalido para ${name}: $($downloadInfo.Length)."
    }
    $actualHash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actualHash -ne $expectedHash) { throw "SHA-256 nao confere para $name." }
    if ($name.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
        $header = New-Object byte[] 2
        $stream = [System.IO.File]::OpenRead($download)
        try { $headerLength = $stream.Read($header, 0, 2) } finally { $stream.Dispose() }
        if ($headerLength -ne 2 -or $header[0] -ne 0x4D -or $header[1] -ne 0x5A) {
            throw "$name nao e um executavel Windows valido."
        }
    }
    return [pscustomobject]@{
        Name = $name
        Download = $download
        Destination = $destination
        Hash = $actualHash
    }
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
    $manifestResponse = Invoke-RestMethod -Uri "${manifestUrl}?t=$cacheBuster" -Method Get -TimeoutSec 30
    if ($manifestResponse -is [string]) {
        $manifest = $manifestResponse.TrimStart([char]0xFEFF) | ConvertFrom-Json
    } else {
        $manifest = $manifestResponse
    }
    $remoteVersion = [version]([string]$manifest.version)
    if ($remoteVersion -le $localVersion) { return }

    New-Item -ItemType Directory -Path $updateDir -Force | Out-Null
    $downloads = @()
    foreach ($entry in (Get-ManifestFiles $manifest)) {
        $downloaded = Download-UpdateFile $entry
        if ($downloaded) { $downloads += $downloaded }
    }

    $exeUpdate = $downloads | Where-Object { $_.Name -eq 'desktop-integrador.exe' }
    if ($exeUpdate) {
        $targetName = [System.IO.Path]::GetFileName($exeUpdate.Destination)
        Get-CimInstance Win32_Process -Filter "Name='$targetName'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -eq $exeUpdate.Destination } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 800
    }

    # Atualiza o proprio script por ultimo. O PowerShell ja carregou esta execucao em memoria.
    $orderedDownloads = @($downloads | Sort-Object { if ($_.Name -eq 'atualizador_mix.ps1') { 1 } else { 0 } })
    $applied = @()
    try {
        foreach ($item in $orderedDownloads) {
            $backup = "$($item.Destination).bak"
            Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
            $existed = Test-Path -LiteralPath $item.Destination -PathType Leaf
            if ($existed -and $item.Name -eq 'atualizador_mix.ps1') {
                Copy-Item -LiteralPath $item.Destination -Destination $backup -Force
                Copy-Item -LiteralPath $item.Download -Destination $item.Destination -Force
                Remove-Item -LiteralPath $item.Download -Force
            } elseif ($existed) {
                [System.IO.File]::Replace($item.Download, $item.Destination, $backup, $true)
            } else {
                Move-Item -LiteralPath $item.Download -Destination $item.Destination
            }
            $applied += [pscustomobject]@{
                Destination = $item.Destination
                Backup = $backup
                Existed = $existed
            }
        }

        $componentHashes = [ordered]@{}
        foreach ($entry in (Get-ManifestFiles $manifest)) {
            $componentHashes[[string]$entry.name] = ([string]$entry.sha256).ToUpperInvariant()
        }
        $versionTemp = "$versionFile.tmp"
        $versionJson = [ordered]@{
            version = [string]$manifest.version
            channel = [string]$manifest.channel
            installed_at = [DateTimeOffset]::UtcNow.ToString('o')
            components = $componentHashes
        } | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText(
            $versionTemp, $versionJson, [System.Text.UTF8Encoding]::new($false)
        )
        Copy-Item -LiteralPath $versionTemp -Destination $versionFile -Force
        Remove-Item -LiteralPath $versionTemp -Force
        if ($exeUpdate -and (Test-Path -LiteralPath $exeUpdate.Destination)) {
            Start-Process -FilePath $exeUpdate.Destination -WorkingDirectory $work
        }
        Write-UpdateLog "Atualizado de $localVersion para $remoteVersion; $($downloads.Count) componente(s) alterado(s)."
    } catch {
        $applyError = $_.Exception.Message
        $failedName = if ($item) { $item.Name } else { 'versao local' }
        for ($index = $applied.Count - 1; $index -ge 0; $index--) {
            $item = $applied[$index]
            if ($item.Existed -and (Test-Path -LiteralPath $item.Backup)) {
                Copy-Item -LiteralPath $item.Backup -Destination $item.Destination -Force
            } elseif (-not $item.Existed) {
                Remove-Item -LiteralPath $item.Destination -Force -ErrorAction SilentlyContinue
            }
        }
        if ($exeUpdate -and (Test-Path -LiteralPath $exeUpdate.Destination)) {
            Start-Process -FilePath $exeUpdate.Destination -WorkingDirectory $work
        }
        throw "Falha ao aplicar ${failedName}: $applyError"
    }
} catch {
    Write-UpdateLog "Falha na verificacao/atualizacao: $($_.Exception.Message)"
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
