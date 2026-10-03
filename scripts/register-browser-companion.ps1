param([ValidateSet('chrome','edge')][string]$Browser,[switch]$Unregister)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$manifestPath=Join-Path $projectRoot '.local/browser-companion/com.workpilot.browser_companion.json'
$vendor=if($Browser -eq 'chrome'){'Google/Chrome'}else{'Microsoft/Edge'}
$keyPath="HKCU:/Software/$vendor/NativeMessagingHosts/com.workpilot.browser_companion"
if(Test-Path -LiteralPath $keyPath){$current=(Get-Item -LiteralPath $keyPath).GetValue('');if($current -and $current -ne $manifestPath){throw 'Another WorkPilot checkout owns this registration; it was not changed.'}}
if($Unregister){if(Test-Path -LiteralPath $keyPath){Remove-Item -LiteralPath $keyPath};Write-Output "Removed WorkPilot Companion registration for $Browser.";exit}
if(-not(Test-Path -LiteralPath $manifestPath)){throw 'Run node scripts/prepare-browser-companion.mjs first.'}
New-Item -Path $keyPath -Force | Out-Null
Set-Item -LiteralPath $keyPath -Value $manifestPath
Write-Output "Registered WorkPilot Companion for $Browser. Load the extension and connect a tab explicitly in the browser."
