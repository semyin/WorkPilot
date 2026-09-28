param([string]$Source)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../assets/icons'))
if (-not $Source) { $Source = Join-Path $iconRoot 'source/workpilot-approved.png' }
$Source = [IO.Path]::GetFullPath($Source)
New-Item -ItemType Directory -Force (Join-Path $iconRoot 'png') | Out-Null

function Write-BigEndian32($Writer, [int]$Value) {
    $bytes = [BitConverter]::GetBytes($Value)
    [Array]::Reverse($bytes)
    $Writer.Write($bytes)
}

$sourceImage = [Drawing.Bitmap]::new($Source)
try {
    if ($sourceImage.Width -ne $sourceImage.Height) { throw 'Source icon must be square.' }
    $sizes = @(16,20,24,32,40,48,64,128,256,512,1024)
    foreach ($size in $sizes) {
        $bitmap = [Drawing.Bitmap]::new($size,$size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $attributes = [Drawing.Imaging.ImageAttributes]::new()
        try {
            $graphics.Clear([Drawing.Color]::Transparent)
            $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $attributes.SetWrapMode([Drawing.Drawing2D.WrapMode]::TileFlipXY)
            $graphics.DrawImage($sourceImage,[Drawing.Rectangle]::new(0,0,$size,$size),0,0,$sourceImage.Width,$sourceImage.Height,[Drawing.GraphicsUnit]::Pixel,$attributes)
            $bitmap.Save((Join-Path $iconRoot "png/$size.png"),[Drawing.Imaging.ImageFormat]::Png)
        } finally { $attributes.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
    }
} finally { $sourceImage.Dispose() }
Copy-Item -LiteralPath (Join-Path $iconRoot 'png/1024.png') -Destination (Join-Path $iconRoot 'icon.png') -Force

# Windows ICO: uncompressed 32-bit DIB frames below 256px, PNG frame at 256px.
$icoSizes = @(16,20,24,32,40,48,64,128,256)
$frames = [Collections.Generic.List[byte[]]]::new()
foreach ($size in $icoSizes) {
    $pngPath = Join-Path $iconRoot "png/$size.png"
    if ($size -eq 256) { $frames.Add([IO.File]::ReadAllBytes($pngPath)); continue }
    $bitmap = [Drawing.Bitmap]::new($pngPath)
    $memory = [IO.MemoryStream]::new()
    $writer = [IO.BinaryWriter]::new($memory)
    try {
        $maskStride = [int]([Math]::Ceiling($size/32.0)*4)
        $writer.Write([int]40); $writer.Write([int]$size); $writer.Write([int]($size*2))
        $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([int]0)
        $writer.Write([int]($size*$size*4+$maskStride*$size))
        1..4 | ForEach-Object { $writer.Write([int]0) }
        for ($y=$size-1; $y -ge 0; $y--) {
            for ($x=0; $x -lt $size; $x++) {
                $pixel=$bitmap.GetPixel($x,$y)
                $writer.Write([byte]$pixel.B); $writer.Write([byte]$pixel.G)
                $writer.Write([byte]$pixel.R); $writer.Write([byte]$pixel.A)
            }
        }
        for ($y=$size-1; $y -ge 0; $y--) {
            $mask=[byte[]]::new($maskStride)
            for ($x=0; $x -lt $size; $x++) {
                if ($bitmap.GetPixel($x,$y).A -eq 0) {
                    $index=[int][Math]::Floor($x/8)
                    $mask[$index]=$mask[$index] -bor (128 -shr ($x%8))
                }
            }
            $writer.Write($mask)
        }
        $writer.Flush(); $frames.Add($memory.ToArray())
    } finally { $writer.Dispose(); $memory.Dispose(); $bitmap.Dispose() }
}
$writer=[IO.BinaryWriter]::new([IO.File]::Create((Join-Path $iconRoot 'icon.ico')))
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$icoSizes.Count)
    $offset=6+16*$icoSizes.Count
    for ($i=0; $i -lt $icoSizes.Count; $i++) {
        $dim=if ($icoSizes[$i] -eq 256) {0} else {$icoSizes[$i]}
        $writer.Write([byte]$dim); $writer.Write([byte]$dim)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$i].Length
    }
    foreach ($frame in $frames) { $writer.Write($frame) }
} finally { $writer.Dispose() }

# Modern macOS ICNS PNG representations, including Retina entries.
$icnsEntries=@(@('icp4',16),@('icp5',32),@('icp6',64),@('ic07',128),@('ic08',256),@('ic09',512),@('ic10',1024),@('ic11',32),@('ic12',64),@('ic13',256),@('ic14',512))
$icnsLength=8
foreach ($entry in $icnsEntries) { $icnsLength += 8+(Get-Item (Join-Path $iconRoot "png/$($entry[1]).png")).Length }
$writer=[IO.BinaryWriter]::new([IO.File]::Create((Join-Path $iconRoot 'icon.icns')))
try {
    $writer.Write([Text.Encoding]::ASCII.GetBytes('icns')); Write-BigEndian32 $writer $icnsLength
    foreach ($entry in $icnsEntries) {
        $bytes=[IO.File]::ReadAllBytes((Join-Path $iconRoot "png/$($entry[1]).png"))
        $writer.Write([Text.Encoding]::ASCII.GetBytes($entry[0]))
        Write-BigEndian32 $writer ($bytes.Length+8); $writer.Write($bytes)
    }
} finally { $writer.Dispose() }

# Actual-size preview on light and dark desktop surfaces.
$sheet=[Drawing.Bitmap]::new(920,640,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics=[Drawing.Graphics]::FromImage($sheet)
$font=[Drawing.Font]::new('Segoe UI',10)
$darkBrush=[Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(36,39,43))
try {
    $graphics.Clear([Drawing.Color]::FromArgb(240,241,243))
    $graphics.FillRectangle($darkBrush,0,320,920,320)
    foreach ($row in @(0,1)) {
        $left=24
        foreach ($size in @(16,24,32,48,64,128,256)) {
            $image=[Drawing.Bitmap]::new((Join-Path $iconRoot "png/$size.png"))
            try {
                $top=$row*320+25
                $graphics.DrawImageUnscaled($image,$left,$top)
                $brush=if ($row -eq 0) {[Drawing.Brushes]::Black} else {[Drawing.Brushes]::White}
                $graphics.DrawString("$size px",$font,$brush,[single]$left,[single]($row*320+295))
                $left += [Math]::Max(62,$size+26)
            } finally { $image.Dispose() }
        }
    }
    $sheet.Save((Join-Path $iconRoot 'preview.png'),[Drawing.Imaging.ImageFormat]::Png)
} finally { $font.Dispose(); $darkBrush.Dispose(); $graphics.Dispose(); $sheet.Dispose() }
Write-Output 'Generated PNG, ICO, ICNS and preview assets.'
