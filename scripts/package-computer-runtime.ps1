[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$CacheDirectory = (Join-Path ([IO.Path]::GetTempPath()) 'loom-computer-downloads'),
    [switch]$Verify
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'The computer runtime package requires Windows x64.'
}
if (-not [IO.Path]::IsPathRooted($Destination) -or -not [IO.Path]::IsPathRooted($CacheDirectory)) {
    throw 'Use absolute destination and cache paths.'
}
$Destination = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime\computer-windows.json') -Raw | ConvertFrom-Json
$utf8 = New-Object Text.UTF8Encoding($false)

function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Download-Archive($Entry) {
    $file = Join-Path $CacheDirectory $Entry.filename
    if (-not (Test-Path -LiteralPath $file)) {
        $partial = $file + '.partial-' + [Guid]::NewGuid().ToString('N')
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Entry.url -OutFile $partial -MaximumRedirection 0 -TimeoutSec 120
            if ((Hash $partial) -cne $Entry.sha256) { throw "Download checksum mismatch: $($Entry.filename)" }
            [IO.File]::Move($partial, $file)
        } finally { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial } }
    }
    if ((Hash $file) -cne $Entry.sha256) { throw "Cached archive checksum mismatch: $($Entry.filename)" }
    return $file
}
function Expand-CheckedZip([string]$Archive, [string]$Root) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            $segments = $name.TrimEnd('/').Split('/')
            if (-not $name -or $name -match '[:\\]' -or [IO.Path]::IsPathRooted($name) -or
                @($segments | Where-Object { $_ -in @('', '.', '..') }).Count -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw 'Archive contains an unsafe path.'
            }
            $file = [IO.Path]::GetFullPath((Join-Path $Root $name))
            if (-not $file.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Archive path escapes the runtime directory.'
            }
            if ($name.EndsWith('/')) { [void][IO.Directory]::CreateDirectory($file); continue }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $file, $false)
        }
    } finally { $zip.Dispose() }
}
function Verify-Runtime {
    $manifestPath = Join-Path $Destination 'computer-bundle.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.target -cne $lock.target -or
        $manifest.pythonVersion -cne $lock.python.version -or $manifest.pillowVersion -cne $lock.pillow.version) {
        throw 'Computer runtime metadata does not match the pinned Windows runtime.'
    }
    $expected = @{}
    foreach ($item in $manifest.files) {
        if ($item.path -match '[:\\]' -or [IO.Path]::IsPathRooted($item.path) -or
            @($item.path.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -or
            $item.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $expected.ContainsKey($item.path)) {
            throw 'Invalid computer runtime file list.'
        }
        $expected[$item.path] = $item.sha256
    }
    $count = 0
    foreach ($file in Get-ChildItem -LiteralPath $Destination -Recurse -File -Force) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked runtime files are not supported.' }
        $relative = $file.FullName.Substring($Destination.Length + 1).Replace('\', '/')
        if ($relative -eq 'computer-bundle.json') { continue }
        if (-not $expected.ContainsKey($relative) -or (Hash $file.FullName) -cne $expected[$relative]) {
            throw "Damaged or unexpected computer runtime file: $relative"
        }
        $count++
    }
    if ($count -ne $expected.Count) { throw 'Computer runtime files are missing.' }
    foreach ($required in @('python/python.exe', 'python/python314._pth', 'host_desktop.py', 'mcp_bridge.py',
        'THIRD-PARTY-NOTICES.txt', $lock.python.licenseFile, $lock.pillow.licenseFile)) {
        if (-not $expected.ContainsKey($required)) { throw "Computer runtime is incomplete: $required" }
    }
    # Decode an in-memory PNG, without looking at any screen or sending input.
    $probe = @'
import io, json, sys, ctypes
from PIL import Image, __version__
buffer = io.BytesIO()
Image.new("RGB", (2, 2), (32, 64, 96)).save(buffer, "PNG")
buffer.seek(0)
image = Image.open(buffer)
image.load()
assert image.getpixel((0, 0)) == (32, 64, 96)
assert sys.flags.isolated and sys.flags.no_user_site
assert ctypes.sizeof(ctypes.c_void_p) == 8
print(json.dumps({"python": ".".join(map(str, sys.version_info[:3])), "pillow": __version__, "isolated": True}))
'@
    $info = & (Join-Path $Destination 'python\python.exe') -I -B -c $probe
    if ($LASTEXITCODE -ne 0) { throw 'Bundled Python/Pillow could not run without a system Python.' }
    $info = $info | ConvertFrom-Json
    if ($info.python -cne $lock.python.version -or $info.pillow -cne $lock.pillow.version) { throw 'Unexpected runtime version.' }
    Write-Host "Computer runtime verified: Python $($info.python), Pillow $($info.pillow), $count files."
}

if ($Verify) { Verify-Runtime; return }
if (Test-Path -LiteralPath $Destination) { throw 'Choose a new runtime directory; existing files are never overlaid.' }
[void][IO.Directory]::CreateDirectory($CacheDirectory)
$pythonArchive = Download-Archive $lock.python
$pillowArchive = Download-Archive $lock.pillow
$pythonRoot = Join-Path $Destination 'python'
[void][IO.Directory]::CreateDirectory($pythonRoot)
Expand-CheckedZip $pythonArchive $pythonRoot
Expand-CheckedZip $pillowArchive $pythonRoot
# Keep CPython's isolated ._pth mode. Pillow lives beside python.exe; neither
# user site-packages, the registry, PYTHONPATH nor the working directory is used.
[IO.File]::WriteAllText((Join-Path $pythonRoot 'python314._pth'), "python314.zip`n.`n", $utf8)
foreach ($name in @('host_desktop.py', 'mcp_bridge.py')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "..\resources\computer\$name") -Destination (Join-Path $Destination $name)
}
$notices = @"
LOOM Computer runtime for Windows x64

CPython $($lock.python.version) (PSF-2.0 and bundled third-party notices)
Source: $($lock.python.source)
Archive SHA-256: $($lock.python.sha256)
License and third-party notices: $($lock.python.licenseFile)

Pillow $($lock.pillow.version) (MIT-CMU and bundled third-party notices)
Source: $($lock.pillow.source)
Wheel SHA-256: $($lock.pillow.sha256)
License and third-party notices: $($lock.pillow.licenseFile)
The wheel's complete dist-info/licenses directory is retained.

LOOM host_desktop.py and mcp_bridge.py use the repository LICENSE.
The runtime is private to this package and does not install system Python.
"@
[IO.File]::WriteAllText((Join-Path $Destination 'THIRD-PARTY-NOTICES.txt'), $notices + "`n", $utf8)
$files = @(Get-ChildItem -LiteralPath $Destination -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
    [ordered]@{ path = $_.FullName.Substring($Destination.Length + 1).Replace('\', '/'); sha256 = Hash $_.FullName }
})
$manifest = [ordered]@{
    schema = 1
    target = $lock.target
    pythonVersion = $lock.python.version
    pillowVersion = $lock.pillow.version
    upstream = [ordered]@{ python = $lock.python; pillow = $lock.pillow }
    files = $files
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Destination 'computer-bundle.json') -Encoding utf8
Verify-Runtime
