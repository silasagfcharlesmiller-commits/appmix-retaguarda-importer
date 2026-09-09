$work = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$updater = Join-Path $work 'atualizador_mix.ps1'
if (Test-Path -LiteralPath $updater) { & $updater }

$target = Join-Path $work 'desktop-integrador.exe'
if (-not (Test-Path -LiteralPath $target)) {
    $candidate = Get-ChildItem -LiteralPath $work -File -Filter '*integrador*.exe' |
        Where-Object { $_.Name -notlike 'Instalador*' } |
        Select-Object -First 1
    if (-not $candidate) {
        $allExe = @(Get-ChildItem -LiteralPath $work -File -Filter '*.exe' |
            Where-Object { $_.Name -notlike 'Instalador*' })
        if ($allExe.Count -eq 1) { $candidate = $allExe[0] }
    }
    if (-not $candidate) { return }
    $target = $candidate.FullName
}

$processName = [System.IO.Path]::GetFileName($target)
$running = Get-CimInstance Win32_Process -Filter "Name='$processName'" `
    -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $target }
if (-not $running -and (Test-Path -LiteralPath $target)) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath (Join-Path $work 'monitor_log.txt') `
        -Value "[$stamp] Integrador parado; reiniciando." -Encoding UTF8
    Start-Process -FilePath $target -WorkingDirectory $work
}
