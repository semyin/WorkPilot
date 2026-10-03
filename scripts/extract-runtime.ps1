param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$allowedRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.local/p12-runtime-downloads'))
$target=[IO.Path]::GetFullPath($Destination)
if(-not $target.StartsWith($allowedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Extraction target must be inside the runtime cache' }
if(Test-Path -LiteralPath $target) { throw 'Extraction needs a new directory; existing files are preserved' }
$zip=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
  $total=[long]0
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  if($zip.Entries.Count -gt 100000) { throw 'Archive has too many entries' }
  foreach($entry in $zip.Entries) {
    $name=$entry.FullName.Replace('\','/')
    if($name -match '(^/|:|(^|/)\.\.?(/|$)|[\x00-\x1f])') { throw 'Unsafe archive path' }
    if((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Archive links are not supported' }
    $path=[IO.Path]::GetFullPath((Join-Path $target $name))
    if(-not $path.StartsWith($target+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes destination' }
    if(-not $seen.Add($path)) { throw 'Duplicate archive path' }
    $total += $entry.Length
    if($total -gt 4GB) { throw 'Unpacked runtime exceeds limit' }
  }
} finally { $zip.Dispose() }
[void][IO.Directory]::CreateDirectory($target)
[IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($Archive),$target)
