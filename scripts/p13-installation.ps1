param(
  [ValidateSet('Install','Uninstall')][Parameter(Mandatory=$true)][string]$Action,
  [string]$Installer,
  [string]$Session
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = [IO.Path]::GetFullPath((Join-Path $repo '.test-results/p13-installation'))
$uninstallKey = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/WorkPilot'
$productKey = 'HKCU:/Software/workpilot/WorkPilot'
$runKey = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run'
$node = @(Get-Command node -CommandType Application)[0].Source
function Test-ChildPath([string]$Parent, [string]$Child) {
  $p = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $c = [IO.Path]::GetFullPath($Child)
  if (-not $c.StartsWith($p + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Test destination is outside the owned installation test directory'
  }
  return $c
}
function Save-Report($Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
}
function Read-BrowserRegistrations {
  $value = & $node (Join-Path $repo 'scripts/browser-registration-snapshot.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the current browser registrations' }
  return ($value -join "`n")
}
if ($Action -eq 'Install') {
  if (-not $Installer) { throw 'Installer path is required' }
  $Installer = [IO.Path]::GetFullPath($Installer)
  $delivery = Split-Path -Parent $Installer
  $allowedDeliveries = @(
    (Join-Path $repo 'artifacts/workpilot-p13-candidate-2026-10-04'),
    (Join-Path $repo 'artifacts/workpilot-p13-candidate-2026-10-04-r2'),
    (Join-Path $repo 'artifacts/workpilot-p13-candidate-2026-10-04-r3')
  ) | ForEach-Object { [IO.Path]::GetFullPath($_) }
  if ($delivery -notin $allowedDeliveries) { throw 'Use an explicitly recorded P13 candidate directory' }
  $manifest = Get-Content -LiteralPath (Join-Path $delivery 'installer-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $package = Get-Content -LiteralPath (Join-Path $delivery 'source-and-binary-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.version -notin @('0.1.0-alpha.13.2','0.1.0-alpha.13.3','0.1.0-alpha.13.4') -or
      $manifest.version -ne $package.versions.app -or
      $manifest.packagedBuild.desktopSha256 -ne $package.build.desktop -or
      $manifest.packagedBuild.engineSha256 -ne $package.build.engine -or
      ([IO.Path]::GetFileName($Installer)) -ne $manifest.file -or
      (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) {
    throw 'The installer is not the exact recorded P13 candidate'
  }
  if ((Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath $productKey)) {
    throw 'An existing installation owns WorkPilot registration; preserve it'
  }
  if (Get-ItemProperty -LiteralPath $runKey -Name WorkPilot -ErrorAction SilentlyContinue) {
    throw 'An existing startup entry must be preserved'
  }
  $links = @(
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'WorkPilot.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'WorkPilot/WorkPilot.lnk'),
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'WorkPilot.lnk')
  )
  if ($links | Where-Object { Test-Path -LiteralPath $_ }) {
    throw 'An existing WorkPilot shortcut must be preserved; do not replace it in an acceptance test'
  }
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  $Session = Test-ChildPath $testRoot (Join-Path $testRoot ('session-' + [Guid]::NewGuid().ToString('N')))
  $installRoot = Test-ChildPath $Session (Join-Path $Session '中文 安装')
  $expectedLabel = -join ([char[]](0x4e2d,0x6587,0x20,0x5b89,0x88c5))
  if ([IO.Path]::GetFileName($installRoot) -cne $expectedLabel) {
    throw 'The test shell decoded the intended Chinese path incorrectly; use a UTF-8 aware shell'
  }
  New-Item -ItemType Directory -Path $installRoot | Out-Null
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='workpilot-desktop.exe' OR Name='workpilot-sidecar.exe'" |
    Select-Object ProcessId,ExecutablePath,@{Name='CreatedUtcTicks';Expression={[string]$_.CreationDate.ToUniversalTime().Ticks}})
  if ($processes | Where-Object { -not $_.ExecutablePath }) { throw 'Cannot verify existing process ownership' }
  $report = [ordered]@{
    at=[DateTime]::UtcNow.ToString('o'); version=$manifest.version; installerSha256=$manifest.sha256
    session=$Session; installRoot=$installRoot; environment='Current Windows development machine, not a clean OS'
    preexistingProcesses=$processes; browserRegistrationsBefore=(Read-BrowserRegistrations); shortcuts=$links; status='installing'; checks=@()
  }
  $receipt = Join-Path $Session 'lifecycle.json'
  Save-Report $receipt $report
  [IO.File]::WriteAllText((Join-Path $installRoot 'user-created.txt'), 'preserve-unlisted-test-file')
  $project = Join-Path $Session 'preserved-project'
  New-Item -ItemType Directory -Path $project | Out-Null
  [IO.File]::WriteAllText((Join-Path $project 'result.txt'), 'preserve-test-project')
  try {
    # Keep the standard start-menu shortcut: Windows uses its AppUserModelID for real toasts.
    $p = Start-Process -FilePath $Installer -ArgumentList @('/S',('/D=' + $installRoot)) -WindowStyle Hidden -PassThru -Wait
    if ($p.ExitCode -ne 0) { throw ('Installer exit code ' + $p.ExitCode) }
    if ((Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation.Trim('"') -ne $installRoot) {
      throw 'Unexpected installed location'
    }
    $binary = Join-Path $installRoot 'workpilot-desktop.exe'
    $source = Join-Path $delivery 'preview/workpilot-desktop.exe'
    if ((Get-FileHash -LiteralPath $binary).Hash -ne (Get-FileHash -LiteralPath $source).Hash) {
      throw 'Installed application bytes differ from the tested preview'
    }
    if ((Read-BrowserRegistrations) -cne $report.browserRegistrationsBefore) {
      throw 'Installation changed an existing browser connection'
    }
    $report.status='installed_pending_native_and_uninstall_checks'
    $report.checks += 'exact_installer_current_user_chinese_space_path_binary_hash_and_registration'
  } catch { $report.status='failed'; $report.error=$_.Exception.Message; throw }
  finally { Save-Report $receipt $report }
  Save-Report (Join-Path $testRoot 'latest.json') @{session=$Session;installRoot=$installRoot}
  @{session=$Session;installRoot=$installRoot;status=$report.status} | ConvertTo-Json
  exit 0
}
if (-not $Session) { throw 'Exact owned session path is required for uninstall' }
$Session = Test-ChildPath $testRoot $Session
$receipt = Join-Path $Session 'lifecycle.json'
$report = Get-Content -LiteralPath $receipt -Raw -Encoding UTF8 | ConvertFrom-Json
$installRoot = Test-ChildPath $Session $report.installRoot
if ($report.session -cne $Session -or (Split-Path -Parent $installRoot) -cne $Session) {
  throw 'Owned test session identity differs'
}
if ((Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation.Trim('"') -cne $installRoot -or
    (Get-Item -LiteralPath $productKey).GetValue('') -cne $installRoot) {
  throw 'Installation ownership changed; do not uninstall'
}
if (Get-CimInstance Win32_Process -Filter "Name='workpilot-desktop.exe' OR Name='workpilot-sidecar.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase) }) {
  throw 'Quit the owned installed test desktop normally before uninstalling'
}
$databases = @(Get-ChildItem -LiteralPath $Session -Recurse -File -Filter '*.sqlite3' |
  ForEach-Object { @{Path=$_.FullName;Hash=(Get-FileHash -LiteralPath $_.FullName).Hash} })
$runningBeforeUninstall = @()
foreach ($prior in $report.preexistingProcesses) {
  $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($prior.ProcessId)"
  if ($live -and $live.ExecutablePath -ceq $prior.ExecutablePath -and
      [string]$live.CreationDate.ToUniversalTime().Ticks -eq $prior.CreatedUtcTicks) {
    $runningBeforeUninstall += $prior
  }
}
try {
  $uninstaller = Join-Path $installRoot 'uninstall.exe'
  $p = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw ('Uninstaller exit code ' + $p.ExitCode) }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ((Test-Path -LiteralPath $uninstaller) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if ((Test-Path -LiteralPath (Join-Path $installRoot 'workpilot-desktop.exe')) -or (Test-Path -LiteralPath $uninstallKey)) {
    throw 'Uninstall did not remove the owned application'
  }
  if ([IO.File]::ReadAllText((Join-Path $installRoot 'user-created.txt')) -ne 'preserve-unlisted-test-file' -or
      [IO.File]::ReadAllText((Join-Path $Session 'preserved-project/result.txt')) -ne 'preserve-test-project') {
    throw 'Uninstall altered an unlisted file or project'
  }
  foreach ($db in $databases) {
    if ((Get-FileHash -LiteralPath $db.Path).Hash -ne $db.Hash) { throw 'Uninstall altered test records' }
  }
  foreach ($prior in $runningBeforeUninstall) {
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($prior.ProcessId)"
    if (-not $live -or $live.ExecutablePath -cne $prior.ExecutablePath -or
        [string]$live.CreationDate.ToUniversalTime().Ticks -ne $prior.CreatedUtcTicks) {
      throw 'A preexisting application process is no longer the same instance; inspect before claiming preservation'
    }
  }
  if ((Read-BrowserRegistrations) -cne $report.browserRegistrationsBefore) { throw 'Existing browser registrations changed' }
  if ($report.shortcuts | Where-Object { Test-Path -LiteralPath $_ }) { throw 'An owned installer shortcut was not removed' }
  if (Get-ItemProperty -LiteralPath $runKey -Name WorkPilot -ErrorAction SilentlyContinue) { throw 'Unexpected startup entry' }
  if (Test-Path -LiteralPath $productKey) {
    if ((Get-Item -LiteralPath $productKey).GetValue('') -cne $installRoot) { throw 'Unexpected product key owner' }
    Remove-Item -LiteralPath $productKey
  }
  $report.status='passed'
  $report.checks += 'uninstall_only_owned_files_keeps_project_unknown_file_databases_existing_processes_and_browser_registrations'
  $report | Add-Member -NotePropertyName preservedDatabaseFiles -NotePropertyValue $databases.Count -Force
  $report | Add-Member -NotePropertyName existingProcessesPreservedAtUninstall -NotePropertyValue $runningBeforeUninstall.Count -Force
} catch {
  $report.status='failed'
  $report | Add-Member -NotePropertyName error -NotePropertyValue $_.Exception.Message -Force
  throw
} finally {
  $report | Add-Member -NotePropertyName finishedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
  Save-Report $receipt $report
}
$report | Select-Object status,checks,preservedDatabaseFiles | ConvertTo-Json
