param([Parameter(Mandatory=$true)][string]$Targets, [Parameter(Mandatory=$true)][string]$StopFile, [int]$IntervalMs=250)
$ErrorActionPreference = 'Stop'
$identities = @{}
$tick = 0
while (-not (Test-Path -LiteralPath $StopFile)) {
    $tick++
    try {
        # Windows PowerShell 5.1 emits a JSON array as one pipeline object.
        # Assign directly so foreach enumerates its entries instead of a nested array.
        $entries = [IO.File]::ReadAllText($Targets) | ConvertFrom-Json
        foreach ($entry in $entries) {
            $sampled = $null
            try {
                $sampled = [Diagnostics.Process]::GetProcessById([int]$entry.pid)
                $sampled.Refresh()
                $identity = $sampled.StartTime.ToUniversalTime().Ticks.ToString()
                $startedAtMs = ([DateTimeOffset]$sampled.StartTime).ToUnixTimeMilliseconds()
                if ($null -ne $entry.startedAtMs -and $startedAtMs -ne [long]$entry.startedAtMs) { continue }
                $key = $entry.pid.ToString() + ':' + [string]$entry.startedAtMs
                if ($identities.ContainsKey($key) -and $identities[$key] -ne $identity) { continue }
                if (-not [string]::Equals($sampled.MainModule.FileName, [string]$entry.path, [StringComparison]::OrdinalIgnoreCase)) { continue }
                $identities[$key] = $identity
                [ordered]@{
                    atMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                    tick = $tick
                    targetVersion = $entry.targetVersion
                    pid = $sampled.Id
                    startedAtMs = $startedAtMs
                    role = $entry.role
                    phase = $entry.phase
                    workingSetBytes = $sampled.WorkingSet64
                    privateBytes = $sampled.PrivateMemorySize64
                    cpuMs = $sampled.TotalProcessorTime.TotalMilliseconds
                    handles = $sampled.HandleCount
                    threads = $sampled.Threads.Count
                } | ConvertTo-Json -Compress
            } catch {
                # Exited targets are expected during stop and restart samples.
            } finally {
                if ($null -ne $sampled) { $sampled.Dispose() }
            }
        }
    } catch {
        # The producer atomically replaces only this benchmark's target list.
    }
    Start-Sleep -Milliseconds $IntervalMs
}
