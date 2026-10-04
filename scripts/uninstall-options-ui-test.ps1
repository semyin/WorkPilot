$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$folder=Join-Path $repo ('.test-results/uninstall-options-ui/'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($folder)
$compiler=Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
$options=Join-Path $repo 'resources/windows/uninstall-options.nsh'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class WPUninstallUi {
 public delegate bool Callback(IntPtr w,IntPtr l);
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p,Callback c,IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr w,StringBuilder t,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w,out Rect r);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
 [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr w);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr w,uint m,IntPtr a,IntPtr b);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr w,IntPtr dc,uint flags);
}
'@
$report=[ordered]@{at=[DateTime]::UtcNow.ToString('o');scope='Actual NSIS confirmation controls; only the isolated test uninstaller is inspected and terminated';checks=@();state='running'}
try {
  foreach($language in @('English','SimpChinese')) {
    $install=Join-Path $folder $language
    $setup=Join-Path $folder ($language+'-setup.exe')
    $source=Join-Path $folder ($language+'.nsi')
    $script=@'
Unicode true
RequestExecutionLevel user
SilentInstall silent
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include "__OPTIONS__"
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
LangString wpDeleteCache ${LANG_ENGLISH} "Remove desktop web-view cache"
LangString wpDeleteCache ${LANG_SIMPCHINESE} "删除桌面网页缓存"
LangString wpDeleteHistory ${LANG_ENGLISH} "Clear WorkPilot history, settings and saved credentials. Keep project files."
LangString wpDeleteHistory ${LANG_SIMPCHINESE} "清空 WorkPilot 历史、设置与已保存的凭据；保留项目文件。"
Name "WorkPilot uninstall options test"
OutFile "__OUTPUT__"
Function un.onInit
  StrCpy $LANGUAGE __LANGUAGE__
  StrCpy $DeleteWorkPilotHistoryCheckboxState 0
FunctionEnd
Section
  CreateDirectory "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd
Section Uninstall
  FileOpen $0 "$INSTDIR\confirmed-choice.txt" w
  FileWrite $0 "$DeleteWorkPilotHistoryCheckboxState|$DeleteAppDataCheckboxState"
  FileClose $0
  Quit
SectionEnd
'@
    $languageId=if($language -eq 'English'){1033}else{2052}
    [IO.File]::WriteAllText($source,$script.Replace('__OPTIONS__',$options).Replace('__OUTPUT__',$setup).Replace('__LANGUAGE__',[string]$languageId),(New-Object Text.UTF8Encoding($true)))
    & $compiler '/V2' $source
    if($LASTEXITCODE -ne 0){throw 'Options harness compilation failed'}
    Start-Process -FilePath $setup -ArgumentList @('/S',('/D='+$install)) -WindowStyle Hidden -Wait | Out-Null
    $launcher=Start-Process -FilePath (Join-Path $install 'uninstall.exe') -WindowStyle Hidden -PassThru
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    $script:window=[IntPtr]::Zero
    while($script:window -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {
      $ids=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($install) -and $_.Name -like 'Un*.exe' } | ForEach-Object {$_.ProcessId})
      [WPUninstallUi]::EnumWindows({param($w,$l) $p=0;[void][WPUninstallUi]::GetWindowThreadProcessId($w,[ref]$p);if($ids -contains $p -and [WPUninstallUi]::IsWindowVisible($w)){$script:window=$w};return $true},[IntPtr]::Zero)|Out-Null
      if($script:window -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 100}
    }
    if($script:window -eq [IntPtr]::Zero){throw 'Isolated uninstall confirmation not visible'}
    $script:controls=@()
    $script:historyCheckbox=[IntPtr]::Zero
    [WPUninstallUi]::EnumChildWindows($script:window,{param($w,$l)
      $text=New-Object Text.StringBuilder 1024;[void][WPUninstallUi]::GetWindowText($w,$text,1024)
      if($text.ToString() -match 'Clear WorkPilot|清空 WorkPilot|web-view cache|桌面网页缓存') {
        if($text.ToString() -match 'Clear WorkPilot|清空 WorkPilot'){$script:historyCheckbox=$w}
        $r=New-Object WPUninstallUi+Rect;$p=New-Object WPUninstallUi+Rect
        [void][WPUninstallUi]::GetWindowRect($w,[ref]$r);[void][WPUninstallUi]::GetWindowRect([WPUninstallUi]::GetParent($w),[ref]$p)
        $script:controls+=@{text=$text.ToString();checked=[WPUninstallUi]::SendMessage($w,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32();visible=[WPUninstallUi]::IsWindowVisible($w);left=$r.Left;top=$r.Top;right=$r.Right;bottom=$r.Bottom;parent=@{left=$p.Left;top=$p.Top;right=$p.Right;bottom=$p.Bottom}}
      };return $true
    },[IntPtr]::Zero)|Out-Null
    if($script:controls.Count -ne 2){throw 'Expected two independent cleanup controls'}
    $report.latestControls=$script:controls
    foreach($control in $script:controls) {
      if($control.checked -ne 0 -or -not $control.visible){throw 'Cleanup must be visible and unchecked by default'}
      if($control.left -lt $control.parent.left -or $control.top -lt $control.parent.top -or $control.right -gt $control.parent.right -or $control.bottom -gt $control.parent.bottom){throw ('Cleanup control clipped: '+($control|ConvertTo-Json -Compress))}
    }
    $rect=New-Object WPUninstallUi+Rect;[void][WPUninstallUi]::GetWindowRect($script:window,[ref]$rect)
    $bitmap=New-Object Drawing.Bitmap ($rect.Right-$rect.Left),($rect.Bottom-$rect.Top)
    $graphics=[Drawing.Graphics]::FromImage($bitmap);$hdc=$graphics.GetHdc()
    [void][WPUninstallUi]::PrintWindow($script:window,$hdc,2);$graphics.ReleaseHdc($hdc)
    $image=Join-Path $folder ($language+'.png');$bitmap.Save($image,[Drawing.Imaging.ImageFormat]::Png);$graphics.Dispose();$bitmap.Dispose()
    $report.checks+=@{language=$language;state='passed';controls=$script:controls;screenshot=$image}
    [void][WPUninstallUi]::SendMessage($script:historyCheckbox,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
    if([WPUninstallUi]::SendMessage($script:historyCheckbox,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -ne 1){throw 'History checkbox cannot be selected'}
    [void][WPUninstallUi]::SendMessage($script:window,0x111,[IntPtr]1,[IntPtr]::Zero)
    $choice=Join-Path $install 'confirmed-choice.txt';$waitUntil=[DateTime]::UtcNow.AddSeconds(10);$selected=''
    while($selected -ne '1|0' -and [DateTime]::UtcNow -lt $waitUntil){try {$selected=[IO.File]::ReadAllText($choice)}catch [IO.IOException]{};if($selected -ne '1|0'){Start-Sleep -Milliseconds 50}}
    if($selected -ne '1|0'){throw 'Native confirmation did not deliver the exact selected scope'}
    $report.checks[-1].confirmationCallback='history-selected-cache-unselected'
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($install) -and $_.Name -like 'Un*.exe' } | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
  }
  $report.state='passed'
} catch { $report.state='failed';$report.error=$_.Exception.Message }
finally {
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($folder) -and $_.Name -like 'Un*.exe' } | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
  $reportPath=Join-Path $folder 'report.json';[IO.File]::WriteAllText($reportPath,($report|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)));$report|ConvertTo-Json -Depth 8
}
if($report.state -ne 'passed'){exit 1}
