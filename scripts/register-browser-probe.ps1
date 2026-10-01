param(
    [Parameter(Mandatory = $true)][ValidateSet('chrome','edge')][string]$Browser,
    [switch]$Unregister
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $projectRoot '.local/browser-host/com.workpilot.browser_probe.json'
$vendor = if ($Browser -eq 'chrome') { 'Google/Chrome' } else { 'Microsoft/Edge' }
$keyPath = "HKCU:/Software/$vendor/NativeMessagingHosts/com.workpilot.browser_probe"
if ($Unregister) {
    if (Test-Path -LiteralPath $keyPath) {
        $registeredManifest = (Get-Item -LiteralPath $keyPath).GetValue('')
        if ($registeredManifest -ne $manifestPath) { throw 'This registration belongs to a different checkout; it was not changed.' }
        Remove-Item -LiteralPath $keyPath
    }
    Write-Output "Removed the WorkPilot P00 host registration for $Browser."
    exit 0
}
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Run node scripts/prepare-browser-probe.mjs first.' }
if (Test-Path -LiteralPath $keyPath) {
    $registeredManifest = (Get-Item -LiteralPath $keyPath).GetValue('')
    if ($registeredManifest -and $registeredManifest -ne $manifestPath) { throw 'A different checkout owns this host name; it was not changed.' }
}
New-Item -Path $keyPath -Force | Out-Null
Set-Item -LiteralPath $keyPath -Value $manifestPath
Write-Output "Registered WorkPilot P00 native host for $Browser. The browser extension still needs to be loaded by the user."
