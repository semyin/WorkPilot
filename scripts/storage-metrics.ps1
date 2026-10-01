param([Parameter(Mandatory = $true)][string]$TestBinary)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$binary = (Resolve-Path -LiteralPath $TestBinary).Path
$destination = Join-Path $workspace '.test-results/storage-metrics'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$cases = @(
    'one_hundred_thousand_events_use_bounded_pages_and_export',
    'large_output_streams_to_disk_and_content_pages_handle_unicode',
    'blocking_database_work_does_not_block_async_stop_or_heartbeat'
)
$results = @()
foreach ($case in $cases) {
    $stdoutPath = Join-Path $destination ($case + '.stdout.txt')
    $stderrPath = Join-Path $destination ($case + '.stderr.txt')
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $binary -ArgumentList @('--exact', "tests::$case", '--nocapture') -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $peak = 0L
    $samples = 0
    while (-not $process.HasExited) {
        $process.Refresh()
        if (-not $process.HasExited) {
            $peak = [math]::Max($peak, $process.WorkingSet64)
            $samples++
        }
        Start-Sleep -Milliseconds 20
    }
    $process.WaitForExit()
    $timer.Stop()
    $results += [pscustomobject]@{
        test = $case
        exitCode = $process.ExitCode
        elapsedMs = [math]::Round($timer.Elapsed.TotalMilliseconds, 2)
        peakSampledWorkingSetMiB = [math]::Round($peak / 1MB, 2)
        samples = $samples
        output = Get-Content -LiteralPath $stdoutPath -Raw
        stderr = Get-Content -LiteralPath $stderrPath -Raw
    }
}
$report = [pscustomobject]@{
    at = [DateTimeOffset]::Now.ToString('o')
    binary = $binary
    sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    scope = 'Windows debug Rust test process; sampled working set includes test harness. Not application total or a release performance promise.'
    cases = $results
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $destination 'report.json') -Encoding utf8
$report | ConvertTo-Json -Depth 5
if (@($results | Where-Object { $_.exitCode -ne 0 }).Count -gt 0) { exit 1 }
