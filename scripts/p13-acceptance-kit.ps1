param(
    [string]$InstallDir,
    [string]$OutputDir,
    [switch]$SelfTest,
    [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$kitRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$taskExitCode = 1
$taskResultDir = $null
try {
    if (-not $InstallDir) {
        Add-Type -AssemblyName System.Windows.Forms
        $picker = New-Object System.Windows.Forms.FolderBrowserDialog
        $picker.Description = '请选择 WorkPilot 安装目录（里面应有 workpilot-desktop.exe）'
        $picker.ShowNewFolderButton = $false
        try {
            if ($picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { exit 0 }
            $InstallDir = $picker.SelectedPath
        } finally { $picker.Dispose() }
    }
    $installation = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $InstallDir).Path).TrimEnd('\')
    if (-not $OutputDir) {
        $token = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
        $OutputDir = Join-Path $env:LOCALAPPDATA ('WorkPilotAcceptance\' + $token)
    }
    $taskResultDir = [IO.Path]::GetFullPath($OutputDir)
    if ((Test-Path -LiteralPath $taskResultDir) -or
        $taskResultDir.StartsWith($installation + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $taskResultDir.StartsWith($kitRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '结果目录必须是安装目录与工具包之外的全新文件夹。'
    }
    [IO.Directory]::CreateDirectory($taskResultDir) | Out-Null
    $manifest = [IO.File]::ReadAllText((Join-Path $kitRoot 'kit-manifest.json')) | ConvertFrom-Json
    foreach ($file in $manifest.files) {
        $candidate = [IO.Path]::GetFullPath((Join-Path $kitRoot $file.path))
        if (-not $candidate.StartsWith($kitRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '工具包清单路径无效。' }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or
            (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -ine $file.sha256) {
            throw ('工具包文件缺失或校验不符：' + $file.path)
        }
    }
    foreach ($file in $manifest.installationFiles) {
        $candidate = [IO.Path]::GetFullPath((Join-Path $installation $file.path))
        if (-not $candidate.StartsWith($installation + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '安装清单路径无效。' }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or
            (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -ine $file.sha256) {
            throw ('所选目录不是这份工具包对应的待验收版本，或文件已损坏：' + $file.path)
        }
    }
    [ordered]@{
        status='passed'
        kitManifestSha256=(Get-FileHash -LiteralPath (Join-Path $kitRoot 'kit-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        installationFiles=$manifest.installationFiles
        powershellVersion=$PSVersionTable.PSVersion.ToString()
        selfTest=[bool]$SelfTest
        kitDirectory=$kitRoot
        launchWorkingDirectory=(Get-Location).Path
        bundledNodePath=(Join-Path $installation 'browser-runtime\node.exe')
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskResultDir 'entry-verification.json') -Encoding UTF8
    Write-Host '开始验收。只使用软件自带组件，不需要安装开发工具，也不需要模型密钥。'
    Write-Host ('测试结果会保存到：' + $taskResultDir)
    Write-Host '组件完整检查和 Office 预览可能需要数分钟，请保留此窗口。'
    $taskNode = Join-Path $installation 'browser-runtime\node.exe'
    $taskRunner = Join-Path $kitRoot 'scripts\p13-acceptance-kit-runner.mjs'
    $taskArguments = @($taskRunner, '--installation', $installation, '--output', $taskResultDir)
    if ($SelfTest) { $taskArguments += '--self-test' }
    & $taskNode @taskArguments | Tee-Object -FilePath (Join-Path $taskResultDir '运行日志.txt')
    $taskExitCode = $LASTEXITCODE
    $taskResult = Join-Path $taskResultDir '验收结果.html'
    if (Test-Path -LiteralPath $taskResult) {
        if (-not $NoOpen) { Invoke-Item -LiteralPath $taskResult }
        Write-Host ('结果说明：' + $taskResult)
    } else { throw '测试未生成结果说明，请保留本目录的运行日志。' }
} catch {
    Write-Host ('本次检查未完成：' + $_.Exception.Message) -ForegroundColor Red
    if ($taskResultDir -and (Test-Path -LiteralPath $taskResultDir -PathType Container)) {
        [ordered]@{ status='bootstrap_failed'; at=[DateTimeOffset]::UtcNow.ToString('o'); error=$_.Exception.Message; selfTest=[bool]$SelfTest } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskResultDir '入口检查未通过.json') -Encoding UTF8
    }
    $taskExitCode = 1
}
exit $taskExitCode
