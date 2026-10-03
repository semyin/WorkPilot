param([Parameter(Mandatory=$true)][ValidateSet('chrome','edge')][string]$Browser,[switch]$Unregister)
$ErrorActionPreference='Stop'
$helper=Join-Path (Split-Path -Parent $PSScriptRoot) 'workpilot-browser-setup.exe'
if(-not(Test-Path -LiteralPath $helper)){throw 'Open WorkPilot settings or reinstall this package: browser setup helper is missing.'}
$action=if($Unregister){'unregister'}else{'register'}
& $helper $action $Browser
if($LASTEXITCODE -ne 0){throw 'Browser setup did not finish. Existing connections were not replaced.'}
