param(
    [Parameter(Mandatory=$true)][string]$Targets,
    [ValidateSet('identify','verify')][string]$Operation = 'identify'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$entries = [IO.File]::ReadAllText($Targets) | ConvertFrom-Json
$results = foreach ($entry in $entries) {
    $sampled = $null
    try {
        $sampled = [Diagnostics.Process]::GetProcessById([int]$entry.pid)
        $path = $sampled.MainModule.FileName
        $startedAtMs = ([DateTimeOffset]$sampled.StartTime).ToUnixTimeMilliseconds()
        $pathMatches = [string]::Equals($path, [string]$entry.path, [StringComparison]::OrdinalIgnoreCase)
        if ($Operation -eq 'identify') {
            if (-not $pathMatches -or ($null -ne $entry.notBeforeMs -and $startedAtMs -lt [long]$entry.notBeforeMs)) {
                throw 'The owned process no longer matches its executable or launch window'
            }
            [ordered]@{pid=$sampled.Id; path=$path; startedAtMs=$startedAtMs}
        } else {
            $same = $pathMatches -and $startedAtMs -eq [long]$entry.startedAtMs
            [ordered]@{pid=$entry.pid; startedAtMs=$entry.startedAtMs; status=$(if($same){'alive'}else{'pid_reused'})}
        }
    } catch [ArgumentException] {
        if ($Operation -eq 'identify') { throw }
        [ordered]@{pid=$entry.pid; startedAtMs=$entry.startedAtMs; status='exited'}
    } finally {
        if ($null -ne $sampled) { $sampled.Dispose() }
    }
}
ConvertTo-Json -InputObject @($results) -Depth 5 -Compress
