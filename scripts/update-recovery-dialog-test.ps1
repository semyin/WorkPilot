param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][ValidateSet('restore','cancel','unstarted','completed','failed')][string]$Expected,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
[void][IO.Directory]::CreateDirectory($OutputDirectory)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class WPRecoveryDialog {
 public delegate bool Callback(IntPtr window,IntPtr data);
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback,IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr window,Callback callback,IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window,int id);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window,int index);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr first,IntPtr second);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rectangle);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window,IntPtr device,uint flags);
}
'@
$owned = Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
$report=[ordered]@{state='running';expected=$Expected;processId=$owned.Id;executable=$Executable;dialogs=@()}
function Wait-Dialog([string]$titlePart) {
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
    $script:found=[IntPtr]::Zero
    [void][WPRecoveryDialog]::EnumWindows({param($window,$data)
      $processId=[uint32]0
      [void][WPRecoveryDialog]::GetWindowThreadProcessId($window,[ref]$processId)
      if($processId -eq $owned.Id -and [WPRecoveryDialog]::IsWindowVisible($window)) {
        $text=New-Object Text.StringBuilder 2048
        [void][WPRecoveryDialog]::GetWindowText($window,$text,$text.Capacity)
        if($text.ToString().Contains($titlePart)) { $script:found=$window }
      }
      return $true
    },[IntPtr]::Zero)
    if($script:found -ne [IntPtr]::Zero) { return $script:found }
    Start-Sleep -Milliseconds 60
  } while([DateTime]::UtcNow -lt $deadline)
  throw "Owned recovery process did not show expected dialog: $titlePart"
}
function Save-Dialog([IntPtr]$window,[string]$name) {
  $rectangle=New-Object WPRecoveryDialog+Rect
  $layoutDeadline=[DateTime]::UtcNow.AddSeconds(3)
  do {
    [void][WPRecoveryDialog]::GetWindowRect($window,[ref]$rectangle)
    if(($rectangle.Right-$rectangle.Left) -ge 300 -and ($rectangle.Bottom-$rectangle.Top) -ge 120) { break }
    Start-Sleep -Milliseconds 50
  } while([DateTime]::UtcNow -lt $layoutDeadline)
  if(($rectangle.Right-$rectangle.Left) -lt 300) { throw 'Recovery dialog did not finish its visible layout' }
  Start-Sleep -Milliseconds 100
  $bitmap=New-Object Drawing.Bitmap ($rectangle.Right-$rectangle.Left),($rectangle.Bottom-$rectangle.Top)
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  $device=$graphics.GetHdc()
  try { [void][WPRecoveryDialog]::PrintWindow($window,$device,2) } finally { $graphics.ReleaseHdc($device) }
  $path=Join-Path $OutputDirectory ($name+'.png')
  $bitmap.Save($path,[Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
  $script:texts=@()
  [void][WPRecoveryDialog]::EnumChildWindows($window,{param($child,$data)
    $text=New-Object Text.StringBuilder 8192
    [void][WPRecoveryDialog]::GetWindowText($child,$text,$text.Capacity)
    if($text.Length -gt 0) { $script:texts += $text.ToString() }
    return $true
  },[IntPtr]::Zero)
  $report.dialogs += [ordered]@{name=$name;text=$script:texts;screenshot=$path}
}
function Click-Button([IntPtr]$window,[int]$id) {
  $button=[WPRecoveryDialog]::GetDlgItem($window,$id)
  if($button -eq [IntPtr]::Zero -and $id -eq 1) {
    $script:acknowledge=[IntPtr]::Zero
    [void][WPRecoveryDialog]::EnumChildWindows($window,{param($child,$data)
      $text=New-Object Text.StringBuilder 128
      [void][WPRecoveryDialog]::GetWindowText($child,$text,$text.Capacity)
      if($text.ToString() -match '^(确定|OK)$') { $script:acknowledge=$child }
      return $true
    },[IntPtr]::Zero)
    $button=$script:acknowledge
  }
  if($button -eq [IntPtr]::Zero) { throw 'Expected recovery dialog button is missing' }
  $buttonProcess=[uint32]0
  [void][WPRecoveryDialog]::GetWindowThreadProcessId($button,[ref]$buttonProcess)
  if($buttonProcess -ne $owned.Id) { throw 'Refusing a dialog outside the owned recovery process' }
  [void][WPRecoveryDialog]::SendMessage($button,0x00f5,[IntPtr]::Zero,[IntPtr]::Zero)
}
try {
  if($Expected -eq 'restore' -or $Expected -eq 'cancel') {
    $window=Wait-Dialog 'Update recovery'
    $no=[WPRecoveryDialog]::GetDlgItem($window,7)
    if(([WPRecoveryDialog]::GetWindowLong($no,-16) -band 1) -ne 1) { throw 'Recovery must default to No' }
    Save-Dialog $window ($Expected+'-confirmation')
    if($Expected -eq 'cancel') { Click-Button $window 7 }
    else {
      Click-Button $window 6
      $window=Wait-Dialog 'Recovery complete'
      Save-Dialog $window 'restore-complete'
      Click-Button $window 1
    }
  } else {
    $expectedTitle=if($Expected -eq 'completed' -or $Expected -eq 'unstarted'){'Recovery status'}else{'Recovery failed'}
    $window=Wait-Dialog $expectedTitle
    Save-Dialog $window $Expected
    Click-Button $window 1
  }
  if(-not $owned.WaitForExit(30000)) { throw 'Owned recovery process did not exit after the result was acknowledged' }
  $owned.Refresh()
  $report.exitCode=$owned.ExitCode
  $expectedExit=if($Expected -eq 'failed'){1}else{0}
  if($owned.ExitCode -ne $expectedExit) { throw "Recovery exited with $($owned.ExitCode), expected $expectedExit" }
  $report.state='passed'
} catch {
  $report.state='failed'; $report.error=$_.Exception.Message
  throw
} finally {
  $owned.Refresh()
  if(-not $owned.HasExited) { Stop-Process -Id $owned.Id -Force -ErrorAction SilentlyContinue }
  [IO.File]::WriteAllText((Join-Path $OutputDirectory ($Expected+'.json')),($report|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}
