param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$allowedRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.local/p12-runtime-downloads'))
$target=[IO.Path]::GetFullPath($Destination)
if(-not $target.StartsWith($allowedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Source target must be inside the runtime cache' }
if(Test-Path -LiteralPath $target) { throw 'Source extraction needs a new directory' }
$zip=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
  $total=[long]0
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  if($zip.Entries.Count -gt 100000) { throw 'Source archive has too many entries' }
  foreach($entry in $zip.Entries) {
    $name=$entry.FullName.Replace('\','/')
    if($name -match '(^/|:|(^|/)\.\.?(/|$)|[\x00-\x1f])') { throw 'Unsafe source archive path' }
    $path=[IO.Path]::GetFullPath((Join-Path $target $name))
    if(-not $path.StartsWith($target+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Source path escapes destination' }
    if(-not $seen.Add($path)) { throw 'Duplicate source path' }
    $total += $entry.Length
    if($total -gt 4GB) { throw 'Unpacked source exceeds limit' }
  }
  [void][IO.Directory]::CreateDirectory($target)
  foreach($entry in $zip.Entries) {
    $path=Join-Path $target $entry.FullName
    if($entry.FullName.EndsWith('/')) { [void][IO.Directory]::CreateDirectory($path); continue }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
    # Git source contains Unix symlink entries. Preserve their target text as
    # ordinary source files on Windows; never create or follow a filesystem link.
    $input=$entry.Open()
    $output=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
  }
} finally { $zip.Dispose() }
