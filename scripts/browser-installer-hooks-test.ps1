$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testBase=Join-Path $repo '.test-results/browser-installer-hooks'
$token=[Guid]::NewGuid().ToString('N')
$testFolder=[IO.Path]::GetFullPath((Join-Path $testBase $token))
if(-not $testFolder.StartsWith($testBase + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe test destination'}
$regPrefix='Software\WorkPilot\InstallerHookTests\'+$token
$regRoot='HKCU:\'+$regPrefix
if(Test-Path -LiteralPath $regRoot){throw 'Test registry namespace already exists'}
[void][IO.Directory]::CreateDirectory($testFolder)
$compiler=Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
if(-not(Test-Path -LiteralPath $compiler)){throw 'Build an NSIS package first to prepare the pinned compiler'}
$hook=Join-Path $repo 'resources/windows/browser-companion-hooks.nsh'
$setup=Join-Path $testFolder 'hook-test-setup.exe'
$source=Join-Path $testFolder 'hook-test.nsi'
$hostName='com.workpilot.browser_companion'
$report=[ordered]@{at=[DateTime]::UtcNow.ToString('o');platform='Windows x64';scope='Actual NSIS installer/uninstaller with the production hook and isolated registry prefix; no daily-browser registration changes';checks=@();status='running'}
$script=@'
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
Var UpdateMode
!define WP_NATIVE_ROOT "__PREFIX__"
!include "__HOOK__"
OutFile "__OUTPUT__"
Section
  CreateDirectory "$INSTDIR\browser-companion"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd
Section Uninstall
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  !insertmacro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\uninstall.exe"
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
'@
[IO.File]::WriteAllText($source,$script.Replace('__PREFIX__',$regPrefix).Replace('__HOOK__',$hook).Replace('__OUTPUT__',$setup),(New-Object Text.UTF8Encoding($false)))
function Test-Equal($actual,$expected,$why){if($actual -cne $expected){throw $why}}
try {
  & $compiler '/V2' $source
  if($LASTEXITCODE -ne 0){throw 'NSIS test harness compilation failed'}
  foreach($scenario in @('owned','foreign','mixed','empty','update')){
    $installRoot=Join-Path $testFolder ('中文 安装 '+$scenario)
    $process=Start-Process -FilePath $setup -ArgumentList @('/S',('/D='+$installRoot)) -WindowStyle Hidden -Wait -PassThru
    if($process.ExitCode -ne 0){throw 'Harness installation failed'}
    $manifest=Join-Path $installRoot ('browser-companion/'+$hostName+'.json')
    [IO.File]::WriteAllText($manifest,'generated-test-manifest')
    [IO.File]::WriteAllText((Join-Path $installRoot 'keep.txt'),'project-and-extra-files-stay')
    $keys=@{}
    foreach($browser in @('chrome','edge')){
      $vendor=if($browser -eq 'chrome'){'Google\Chrome'}else{'Microsoft\Edge'}
      $key=$regRoot+'\'+$vendor+'\NativeMessagingHosts\'+$hostName
      $keys[$browser]=$key
      if($scenario -ne 'empty'){
        New-Item -Path $key -Force | Out-Null
        $owned=($scenario -in @('owned','update') -or ($scenario -eq 'mixed' -and $browser -eq 'chrome'))
        Set-Item -LiteralPath $key -Value $(if($owned){$manifest}else{'C:\Other WorkPilot\browser-companion\'+$hostName+'.json'})
        if($scenario -eq 'owned' -and $browser -eq 'chrome'){
          New-ItemProperty -LiteralPath $key -Name KeepValue -Value 'do-not-delete' -PropertyType String | Out-Null
          New-Item -Path ($key+'\KeepSubkey') | Out-Null
        }
      }
    }
    $uninstaller=Join-Path $installRoot 'uninstall.exe'
    $uninstallArgs=if($scenario -eq 'update'){'/S /UPDATE'}else{'/S'}
    Start-Process -FilePath $uninstaller -ArgumentList $uninstallArgs -WindowStyle Hidden -Wait | Out-Null
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    while((Test-Path -LiteralPath $uninstaller) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
    if(Test-Path -LiteralPath $uninstaller){throw 'Harness uninstall did not finish'}
    foreach($browser in @('chrome','edge')){
      $key=$keys[$browser]
      $actual=if(Test-Path -LiteralPath $key){(Get-Item -LiteralPath $key).GetValue('')}else{$null}
      if($scenario -eq 'update'){
        Test-Equal $actual $manifest 'Update removed the existing registration'
      }elseif($scenario -eq 'foreign' -or ($scenario -eq 'mixed' -and $browser -eq 'edge')){
        Test-Equal $actual ('C:\Other WorkPilot\browser-companion\'+$hostName+'.json') 'Foreign registration was changed'
      }elseif($null -ne $actual){throw 'Owned registration was not removed'}
    }
    if($scenario -eq 'owned'){
      Test-Equal (Get-Item -LiteralPath $keys.chrome).GetValue('KeepValue') 'do-not-delete' 'Unrelated registry value was deleted'
      if(-not(Test-Path -LiteralPath ($keys.chrome+'\KeepSubkey'))){throw 'Unrelated registry subkey was deleted'}
    }
    if($scenario -eq 'update'){
      Test-Equal ([IO.File]::ReadAllText($manifest)) 'generated-test-manifest' 'Update changed the companion manifest'
    }elseif(Test-Path -LiteralPath $manifest){throw 'Generated manifest was retained'}
    Test-Equal ([IO.File]::ReadAllText((Join-Path $installRoot 'keep.txt'))) 'project-and-extra-files-stay' 'Unknown user file was deleted'
    $report.checks+=($scenario+'_registrations_and_unknown_files')
    # This namespace is freshly generated under the fixed test root and never used by browsers.
    if(-not $regRoot.StartsWith('HKCU:\Software\WorkPilot\InstallerHookTests\') -or $regRoot.Split('\')[-1] -ne $token){throw 'Unsafe test registry cleanup'}
    if(Test-Path -LiteralPath $regRoot){Remove-Item -LiteralPath $regRoot -Recurse}
  }
  $report.status='passed'
}catch{$report.status='failed';$report.error=$_.Exception.Message}
finally{
  [IO.File]::WriteAllText((Join-Path $testBase 'report.json'),($report|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  $report|ConvertTo-Json -Depth 8
}
if($report.status -ne 'passed'){exit 1}
