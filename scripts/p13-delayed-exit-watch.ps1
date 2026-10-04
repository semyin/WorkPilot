param(
    [Parameter(Mandatory=$true)][string]$Specification,
    [Parameter(Mandatory=$true)][string]$Output,
    [Parameter(Mandatory=$true)][string]$StopFile
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$writer = [IO.StreamWriter]::new($Output, $false, [Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
$known = @{}
$spec = $null
$clock = [Diagnostics.Stopwatch]::StartNew()
$next = 0L
$tick = 0
function Emit($value) { $writer.WriteLine(($value | ConvertTo-Json -Depth 8 -Compress)) }
function Inspect($entry) {
    $sampled = $null
    try {
        $sampled = [Diagnostics.Process]::GetProcessById([int]$entry.pid)
        $startedAtMs = ([DateTimeOffset]$sampled.StartTime).ToUnixTimeMilliseconds()
        $actualPath = $sampled.MainModule.FileName
        $same = $startedAtMs -eq [long]$entry.startedAtMs -and
            [string]::Equals($actualPath, [string]$entry.path, [StringComparison]::OrdinalIgnoreCase)
        return [ordered]@{status=$(if($same){'alive'}else{'pid_reused'}); actualStartedAtMs=$startedAtMs; actualPath=$actualPath}
    } catch [ArgumentException] {
        return [ordered]@{status='exited'}
    } catch {
        return [ordered]@{status='unreadable'; error=$_.Exception.Message}
    } finally {
        if ($null -ne $sampled) { $sampled.Dispose() }
    }
}
function Add-Known($entry) {
    $key = [string]$entry.pid + ':' + [string]$entry.startedAtMs
    if (-not $known.ContainsKey($key)) {
        $known[$key] = $entry
        Emit ([ordered]@{kind='identity_discovered'; atMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); identity=$entry})
    }
}
try {
    Emit ([ordered]@{kind='watcher_started'; atMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); pid=$PID; intervalMs=1000})
    while (-not (Test-Path -LiteralPath $StopFile)) {
        $tick++
        $sampleStarted = $clock.ElapsedMilliseconds
        try {
            $spec = [IO.File]::ReadAllText($Specification) | ConvertFrom-Json
            foreach ($entry in $spec.observers) { Add-Known $entry }
        } catch {
            Emit ([ordered]@{kind='specification_read_error'; tick=$tick; atMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); error=$_.Exception.Message})
        }
        if ($null -ne $spec -and $null -ne $spec.smokeRunner) {
            $owner = Inspect $spec.smokeRunner
            if ($owner.status -eq 'alive') {
                try {
                    $desktops = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + [int]$spec.smokeRunner.pid))
                    foreach ($desktop in $desktops) {
                        $started = ([DateTimeOffset]$desktop.CreationDate).ToUnixTimeMilliseconds()
                        if ($started -lt [long]$spec.smokeRunner.startedAtMs -or
                            -not [string]::Equals($desktop.ExecutablePath, [string]$spec.installedDesktop, [StringComparison]::OrdinalIgnoreCase)) { continue }
                        Add-Known ([pscustomobject]@{pid=[int]$desktop.ProcessId; parentPid=[int]$desktop.ParentProcessId; startedAtMs=$started; path=$desktop.ExecutablePath; role='smoke-desktop'; label='installed-smoke'})
                        $enginePath = Join-Path ([IO.Path]::GetDirectoryName($spec.installedDesktop)) 'workpilot-sidecar.exe'
                        foreach ($engine in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + [int]$desktop.ProcessId))) {
                            $engineStarted = ([DateTimeOffset]$engine.CreationDate).ToUnixTimeMilliseconds()
                            if ($engineStarted -lt $started -or
                                -not [string]::Equals($engine.ExecutablePath, $enginePath, [StringComparison]::OrdinalIgnoreCase)) { continue }
                            Add-Known ([pscustomobject]@{pid=[int]$engine.ProcessId; parentPid=[int]$engine.ParentProcessId; startedAtMs=$engineStarted; path=$engine.ExecutablePath; role='smoke-engine'; label='installed-smoke'})
                        }
                    }
                } catch {
                    Emit ([ordered]@{kind='owned_discovery_error'; tick=$tick; atMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); error=$_.Exception.Message})
                }
            }
        }
        foreach ($entry in $known.Values) {
            $actual = Inspect $entry
            $required = $entry.role.StartsWith('observer-') -and $spec.requireObserversAlive
            Emit ([ordered]@{
                kind='sample'; tick=$tick; atMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                elapsedMs=$clock.ElapsedMilliseconds; phase=$spec.phase; requiredAlive=$required
                pid=$entry.pid; parentPid=$entry.parentPid; startedAtMs=$entry.startedAtMs; path=$entry.path
                role=$entry.role; label=$entry.label; status=$actual.status; actual=$actual
            })
        }
        Emit ([ordered]@{kind='tick_finished'; tick=$tick; atMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); phase=$spec.phase; scanMs=($clock.ElapsedMilliseconds-$sampleStarted)})
        $next += 1000
        $remaining = $next - $clock.ElapsedMilliseconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min($remaining,1000)) }
    }
    Emit ([ordered]@{kind='watcher_stopped'; atMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); pid=$PID; ticks=$tick})
} finally {
    $writer.Dispose()
}
