param([Parameter(Mandatory = $true)][int]$RootProcessId)
$ErrorActionPreference = 'Stop'
$allProcesses = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize)
$ownedIds = [System.Collections.Generic.HashSet[uint32]]::new()
$ownedIds.Add([uint32]$RootProcessId) | Out-Null
do {
    $previousCount = $ownedIds.Count
    foreach ($process in $allProcesses) {
        if ($ownedIds.Contains([uint32]$process.ParentProcessId)) { $ownedIds.Add([uint32]$process.ProcessId) | Out-Null }
    }
} while ($ownedIds.Count -gt $previousCount)
@($allProcesses | Where-Object { $ownedIds.Contains([uint32]$_.ProcessId) } | ForEach-Object {
    [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;workingSetMiB=[math]::Round([double]$_.WorkingSetSize / 1MB, 2)}
}) | ConvertTo-Json -Compress
