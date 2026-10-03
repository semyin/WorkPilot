param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path $repo '.test-results/installer'
$installRoot = Join-Path $testRoot ('中文 安装-' + [Guid]::NewGuid().ToString('N'))
$installRoot = [IO.Path]::GetFullPath($installRoot)
if (-not $installRoot.StartsWith($testRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test install directory' }
if (Test-Path -LiteralPath $installRoot) { throw 'Test install destination already exists' }
$uninstallKey = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/WorkPilot'
$productKey = 'HKCU:/Software/workpilot/WorkPilot'
$runKey = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run'
if ((Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath $productKey)) { throw 'An existing WorkPilot installation owns the registration; do not overwrite it in a smoke test' }
if ((Get-ItemProperty -LiteralPath $runKey -Name WorkPilot -ErrorAction SilentlyContinue)) { throw 'An existing WorkPilot startup entry must be preserved' }
$otherApps = @(Get-CimInstance Win32_Process -Filter "Name='workpilot-desktop.exe' OR Name='WorkPilot.exe'")
if ($otherApps | Where-Object { -not $_.ExecutablePath -or $_.ExecutablePath.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) }) { throw 'Unable to confirm process ownership for the temporary install' }
$node = @(Get-Command node -CommandType Application)[0].Source
New-Item -ItemType Directory -Path $installRoot | Out-Null
$project = Join-Path $testRoot ('保留 项目-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $project | Out-Null
[IO.File]::WriteAllText((Join-Path $project 'result.txt'), 'project-survives-uninstall')
[IO.File]::WriteAllText((Join-Path $installRoot 'user-created.txt'), 'unknown-file-survives-uninstall')
$report = [ordered]@{ at=[DateTime]::UtcNow.ToString('o'); environment='Windows Home developer machine; not a clean OS'; installFolder=[IO.Path]::GetFileName($installRoot); checks=@(); status='running' }
$oldOutput = $env:WORKPILOT_TEST_OUTPUT
$oldEngine = $env:WORKPILOT_ENGINE_BINARY
$oldDesktop = $env:WORKPILOT_DESKTOP_BINARY
$oldOffice = $env:WORKPILOT_OFFICE_TEST_OUTPUT
$registered = $false
try {
  $process = Start-Process -FilePath ([IO.Path]::GetFullPath($Installer)) -ArgumentList @('/S','/NS',('/D=' + $installRoot)) -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw ('Installer failed: ' + $process.ExitCode) }
  $registered = $true
  if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'workpilot-desktop.exe'))) { throw 'Installed executable is missing' }
  $entry = Get-ItemProperty -LiteralPath $uninstallKey
  if ($entry.InstallLocation.Trim('"') -ne $installRoot) { throw 'Installer wrote an unexpected location' }
  $report.checks += 'current_user_silent_install_in_chinese_space_path_and_uninstall_registration'
  $env:WORKPILOT_ENGINE_BINARY = Join-Path $installRoot 'workpilot-sidecar.exe'
  $env:WORKPILOT_TEST_OUTPUT = Join-Path $testRoot 'engine'
  & $node (Join-Path $repo 'scripts/installation-engine-test.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Installed engine check failed' }
  $engineReport = Get-Content -LiteralPath (Join-Path $env:WORKPILOT_TEST_OUTPUT 'report.json') -Raw | ConvertFrom-Json
  if ($engineReport.knownFailures) { $report.knownFailures = $engineReport.knownFailures }
  $report.checks += 'installed_engine_inventory_supported_runtime_workflows_and_known_limits_recorded'
  $env:WORKPILOT_OFFICE_TEST_OUTPUT = Join-Path $testRoot 'office'
  & $node (Join-Path $repo 'scripts/office-preview-test.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Installed Office preview check failed' }
  $report.checks += 'installed_office_renders_real_documents_without_external_image_fetches'
  $env:WORKPILOT_DESKTOP_BINARY = Join-Path $installRoot 'workpilot-desktop.exe'
  $env:WORKPILOT_TEST_OUTPUT = Join-Path $testRoot 'desktop'
  & $node (Join-Path $repo 'scripts/installation-desktop-smoke.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Installed native desktop check failed' }
  $report.checks += 'installed_native_desktop_checks_and_diagnostic_export'
  $report.status = if($report.knownFailures){'passed_with_known_failure'}else{'passed'}
} catch { $report.status='failed'; $report.error=$_.Exception.Message }
finally {
  $env:WORKPILOT_TEST_OUTPUT=$oldOutput
  $env:WORKPILOT_ENGINE_BINARY=$oldEngine
  $env:WORKPILOT_DESKTOP_BINARY=$oldDesktop
  $env:WORKPILOT_OFFICE_TEST_OUTPUT=$oldOffice
  if ($registered) {
    try {
      $savedDatabases = @(Get-ChildItem -LiteralPath $testRoot -Recurse -File -Filter '*.sqlite3' | ForEach-Object { @{ Path=$_.FullName; Hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
      $actual = (Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation.Trim('"')
      if ($actual -ne $installRoot -or -not $actual.StartsWith($testRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Uninstall ownership check failed' }
      if ((Get-ItemProperty -LiteralPath $runKey -Name WorkPilot -ErrorAction SilentlyContinue)) { throw 'A new unrelated startup entry appeared; retain the test install for inspection' }
      $uninstaller = Join-Path $installRoot 'uninstall.exe'
      $proc = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
      $deadline = [DateTime]::UtcNow.AddSeconds(60)
      while ((Test-Path -LiteralPath $uninstaller) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
      if ((Test-Path -LiteralPath (Join-Path $installRoot 'workpilot-desktop.exe')) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Uninstall did not remove the application' }
      if ([IO.File]::ReadAllText((Join-Path $project 'result.txt')) -ne 'project-survives-uninstall') { throw 'Project was changed' }
      if ([IO.File]::ReadAllText((Join-Path $installRoot 'user-created.txt')) -ne 'unknown-file-survives-uninstall') { throw 'Unlisted install file was removed' }
      foreach($saved in $savedDatabases) {
        if((Get-FileHash -LiteralPath $saved.Path -Algorithm SHA256).Hash -ne $saved.Hash) { throw 'Application test data was changed by uninstall' }
      }
      $report.preservedDatabaseFiles = $savedDatabases.Count
      $report.preexistingApplicationProcessesStillRunning = @($otherApps | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count
      if (Test-Path -LiteralPath $productKey) {
        $owner = (Get-Item -LiteralPath $productKey).GetValue('')
        if ($owner -ne $installRoot) { throw 'Unexpected product registration owner; retained for inspection' }
        Remove-Item -LiteralPath $productKey
      }
      $report.checks += 'uninstall_removes_only_owned_program_and_preserves_projects_and_unlisted_files'
    } catch { $report.status='failed'; $report.cleanupError=$_.Exception.Message }
  }
  [IO.File]::WriteAllText((Join-Path $testRoot 'report.json'),($report | ConvertTo-Json -Depth 8),(New-Object System.Text.UTF8Encoding($false)))
  $report | ConvertTo-Json -Depth 8
}
if ($report.status -notin @('passed','passed_with_known_failure')) { exit 1 }
