param([Parameter(Mandatory=$true)][ValidateSet('chrome','edge')][string]$Browser,[switch]$Unregister)
$ErrorActionPreference='Stop'
$manifestPath=Join-Path $PSScriptRoot 'com.workpilot.browser_companion.json'
$vendor=if($Browser -eq 'chrome'){'Google/Chrome'}else{'Microsoft/Edge'}
$keyPath="HKCU:/Software/$vendor/NativeMessagingHosts/com.workpilot.browser_companion"
if(Test-Path -LiteralPath $keyPath){
  $current=(Get-Item -LiteralPath $keyPath).GetValue('')
  if($current -and $current -ne $manifestPath){throw 'Another WorkPilot location owns this registration. Use that extension or unregister that location first.'}
}
if($Unregister){if(Test-Path -LiteralPath $keyPath){Remove-Item -LiteralPath $keyPath};exit}
$binary=Join-Path $PSScriptRoot 'companion.exe'
if(-not(Test-Path -LiteralPath $binary)){throw 'Keep this script beside companion.exe in the WorkPilot package.'}
$extensionId=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'extension/extension-id.txt') -Raw).Trim()
if($extensionId -notmatch '^[a-p]{32}$'){throw 'Invalid extension id.'}
$manifest=@{name='com.workpilot.browser_companion';description='WorkPilot task browser connection';path=$binary;type='stdio';allowed_origins=@("chrome-extension://$extensionId/")}
[System.IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 4),(New-Object System.Text.UTF8Encoding($false)))
New-Item -Path $keyPath -Force | Out-Null
Set-Item -LiteralPath $keyPath -Value $manifestPath
Write-Output "Registered for $Browser. Load the adjacent extension directory in the browser and connect a tab explicitly."
