param(
    [ValidateSet('discover','verify')][string]$Operation = 'discover',
    [int]$DesktopPid,
    [string]$DesktopPath,
    [string]$ProfilePath,
    [string]$ExpectedFile,
    [switch]$IncludeTools,
    [switch]$TestForceMissingPaths
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Operation -eq 'verify') {
    $expected = [IO.File]::ReadAllText($ExpectedFile) | ConvertFrom-Json
    $results = foreach ($entry in $expected) {
        $sampled = $null
        try {
            $sampled = [Diagnostics.Process]::GetProcessById([int]$entry.pid)
            $startedAtMs = ([DateTimeOffset]$sampled.StartTime).ToUnixTimeMilliseconds()
            $same = $startedAtMs -eq [long]$entry.startedAtMs -and [string]::Equals(
                $sampled.MainModule.FileName, [string]$entry.path, [StringComparison]::OrdinalIgnoreCase)
            [ordered]@{pid=$entry.pid; startedAtMs=$entry.startedAtMs; status=$(if($same){'alive'}else{'pid_reused'})}
        } catch [ArgumentException] {
            [ordered]@{pid=$entry.pid; startedAtMs=$entry.startedAtMs; status='exited'}
        } catch {
            [ordered]@{pid=$entry.pid; startedAtMs=$entry.startedAtMs; status='unreadable'; error=$_.Exception.GetType().Name}
        } finally {
            if ($null -ne $sampled) { $sampled.Dispose() }
        }
    }
    ConvertTo-Json -InputObject @($results) -Depth 5 -Compress
    exit 0
}

$all = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($entry in $all) { $byId[[int]$entry.ProcessId] = $entry }
$desktop = $byId[$DesktopPid]
if ($null -eq $desktop -or -not [string]::Equals($desktop.ExecutablePath, $DesktopPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The owned desktop PID no longer matches its executable'
}
$owned = @{}
$owned[$DesktopPid] = $desktop
$changed = $true
while ($changed) {
    $changed = $false
    foreach ($entry in $all) {
        $entryId = [int]$entry.ProcessId
        $parentId = [int]$entry.ParentProcessId
        if ($owned.ContainsKey($entryId) -or -not $owned.ContainsKey($parentId)) { continue }
        # Exclude old processes whose recorded parent PID was later recycled.
        if ($entry.CreationDate -lt $owned[$parentId].CreationDate) { continue }
        $owned[$entryId] = $entry
        $changed = $true
    }
}
$verifiedWebview = @{}
foreach ($entry in $owned.Values) {
    if ($entry.Name -ieq 'msedgewebview2.exe' -and $entry.CommandLine -and
        $entry.CommandLine.IndexOf($ProfilePath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $verifiedWebview[[int]$entry.ProcessId] = $true
    }
}
$changed = $true
while ($changed) {
    $changed = $false
    foreach ($entry in $owned.Values) {
        $entryId = [int]$entry.ProcessId
        if ($entry.Name -ieq 'msedgewebview2.exe' -and -not $verifiedWebview.ContainsKey($entryId) -and
            $verifiedWebview.ContainsKey([int]$entry.ParentProcessId)) {
            $verifiedWebview[$entryId] = $true
            $changed = $true
        }
    }
}
$enginePath = Join-Path ([IO.Path]::GetDirectoryName($DesktopPath)) 'workpilot-sidecar.exe'
$bundle = [IO.Path]::GetDirectoryName($DesktopPath)
$results = foreach ($entry in $owned.Values) {
    $entryId = [int]$entry.ProcessId
    $executablePath = if ($TestForceMissingPaths) { $null } else { $entry.ExecutablePath }
    if (-not $executablePath) {
        # A short-lived child can exit between the CIM snapshot and path lookup.
        # Only skip an exited/recycled identity; a live unreadable process is an error.
        $sampled = $null
        try {
            $sampled = [Diagnostics.Process]::GetProcessById($entryId)
            $actualStart = ([DateTimeOffset]$sampled.StartTime).ToUnixTimeMilliseconds()
            $expectedStart = ([DateTimeOffset]$entry.CreationDate).ToUnixTimeMilliseconds()
            if ($actualStart -ne $expectedStart) { continue }
            $executablePath = $sampled.MainModule.FileName
            if (-not $executablePath) { throw 'Owned live child has no readable executable path' }
        } catch [ArgumentException] {
            continue
        } catch {
            if ($null -ne $sampled -and $sampled.HasExited) { continue }
            throw
        } finally {
            if ($null -ne $sampled) { $sampled.Dispose() }
        }
    }
    $role = 'other-owned'
    $toolCommandLine = ([string]$entry.CommandLine).Replace('/', '\')
    if ($entryId -eq $DesktopPid) { $role = 'desktop' }
    elseif ([string]::Equals($executablePath, $enginePath, [StringComparison]::OrdinalIgnoreCase)) { $role = 'engine' }
    elseif ($verifiedWebview.ContainsKey($entryId)) { $role = 'ui-webview' }
    elseif ($entry.Name -ieq 'msedgewebview2.exe') { $role = 'unverified-webview' }
    elseif ($IncludeTools -and [string]::Equals($executablePath, (Join-Path $bundle 'chromium-runtime\chrome.exe'), [StringComparison]::OrdinalIgnoreCase)) { $role = 'dedicated-browser' }
    elseif ($IncludeTools -and [string]::Equals($executablePath, (Join-Path $bundle 'office-runtime\office\program\workpilot-office.exe'), [StringComparison]::OrdinalIgnoreCase)) { $role = 'office-converter' }
    elseif ($IncludeTools -and $entry.Name -ieq 'node.exe' -and $toolCommandLine.IndexOf((Join-Path $bundle 'document-runtime\worker.mjs'), [StringComparison]::OrdinalIgnoreCase) -ge 0) { $role = 'document-worker' }
    elseif ($IncludeTools -and $entry.Name -ieq 'node.exe' -and $toolCommandLine.IndexOf((Join-Path $bundle 'browser-runtime\services\browser\driver.mjs'), [StringComparison]::OrdinalIgnoreCase) -ge 0) { $role = 'browser-driver' }
    elseif ($IncludeTools -and [string]::Equals($executablePath, (Join-Path $bundle 'browser-runtime\node.exe'), [StringComparison]::OrdinalIgnoreCase)) { $role = 'node-tool' }
    [ordered]@{
        pid = $entryId
        parentPid = [int]$entry.ParentProcessId
        startedAtMs = ([DateTimeOffset]$entry.CreationDate).ToUnixTimeMilliseconds()
        path = $executablePath
        role = $role
        uiProfileVerified = $verifiedWebview.ContainsKey($entryId)
    }
}
ConvertTo-Json -InputObject @($results) -Depth 5 -Compress
