# Loom (Hark 2.6) Windows Node kit: connect or reconnect this machine.
#
# Pure ASCII on purpose: Windows PowerShell 5.1 reads a BOM-less script as ANSI.
#
# The pairing code never touches argv, the environment, a file, or a log. It is
# read once from a hidden interactive prompt or from the first stdin line and
# handed to loom-node only through its stdin pipe (--pair-code-stdin).
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$connectPath = '/api/v1/nodes/connect'
$loopbackHosts = @('localhost', '127.0.0.1', '::1')

# Server: absolute ws/wss URL that ends at the outbound node channel path.
if ([string]::IsNullOrWhiteSpace($Server)) {
    throw 'Server is empty. Pass -Server wss://host/api/v1/nodes/connect.'
}
if ($Server -match '\s') { throw 'Server must not contain whitespace.' }
if ($Server.Contains('"')) { throw 'Server must not contain a double quote.' }
$parsed = [Uri]$null
if (-not [Uri]::TryCreate($Server, [UriKind]::Absolute, [ref]$parsed)) {
    throw 'Server must be an absolute ws:// or wss:// URL.'
}
if ($null -eq $parsed) { throw 'Server must be an absolute ws:// or wss:// URL.' }
$scheme = $parsed.Scheme.ToLowerInvariant()
if ($scheme -ne 'ws' -and $scheme -ne 'wss') {
    throw 'Server must use the ws:// or wss:// scheme.'
}
if ([string]::IsNullOrEmpty($parsed.Host)) { throw 'Server is missing a host.' }
if (-not $parsed.AbsolutePath.EndsWith($connectPath, [StringComparison]::Ordinal)) {
    throw "Server path must end with ${connectPath}."
}
if ($scheme -eq 'ws') {
    $hostName = $parsed.Host.Trim('[', ']').ToLowerInvariant()
    if ($loopbackHosts -notcontains $hostName) {
        throw 'Plaintext ws:// is only allowed to a loopback host. Use wss:// for a remote server.'
    }
}
$serverUrl = $parsed.AbsoluteUri

# Data directory: holds loom-node's own node.json credential.
if ([string]::IsNullOrWhiteSpace($DataDir)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is not set. Pass -DataDir explicitly.'
    }
    $DataDir = Join-Path $env:LOCALAPPDATA 'LoomNode'
}
if ($DataDir.Contains('"')) { throw 'DataDir must not contain a double quote.' }
$dataDirPath = [IO.Path]::GetFullPath($DataDir)
while ($dataDirPath.EndsWith('\') -or $dataDirPath.EndsWith('/')) {
    # A trailing separator before a closing quote would escape it in argv.
    $dataDirPath = $dataDirPath.Substring(0, $dataDirPath.Length - 1)
}
if ($dataDirPath.Length -lt 3 -or $dataDirPath.EndsWith(':')) {
    throw 'DataDir must be a directory below a drive or share root.'
}
if (-not (Test-Path -LiteralPath $dataDirPath -PathType Container)) {
    [void][IO.Directory]::CreateDirectory($dataDirPath)
}
if (-not (Test-Path -LiteralPath $dataDirPath -PathType Container)) {
    throw "Could not create the data directory: $dataDirPath"
}

$nodePath = Join-Path $PSScriptRoot 'loom-node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "loom-node.exe was not found beside this script: $nodePath"
}
$credentialPath = Join-Path $dataDirPath 'node.json'
$hasCredential = Test-Path -LiteralPath $credentialPath -PathType Leaf

# First pairing only: one code, never stored by this script.
$pairCode = ''
if (-not $hasCredential) {
    if ([Console]::IsInputRedirected) {
        $piped = [Console]::In.ReadLine()
        if ($null -eq $piped) { throw 'No pairing code was found on the first stdin line.' }
        $pairCode = $piped.Trim()
    } else {
        $secure = Read-Host -AsSecureString -Prompt 'One-time pairing code'
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $pairCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
        $secure.Dispose()
    }
    # Errors below never echo the code itself.
    if ($pairCode.Length -eq 0) { throw 'The pairing code is empty.' }
    if ($pairCode.Length -gt 4096) { throw 'The pairing code is longer than loom-node accepts.' }
    foreach ($character in $pairCode.ToCharArray()) {
        if ([char]::IsControl($character)) { throw 'The pairing code contains control characters.' }
    }
    Write-Host "Pairing this node once; the code is used once and not stored by this script."
} else {
    Write-Host "Reconnecting with the stored node credential: $credentialPath"
}

$arguments = '--data-dir "' + $dataDirPath + '" --server "' + $serverUrl + '"'
if (-not $hasCredential) { $arguments = $arguments + ' --pair-code-stdin' }

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodePath
$startInfo.Arguments = $arguments
$startInfo.UseShellExecute = $false
# Pairing writes one line to stdin; a reconnect has nothing to hand over.
$startInfo.RedirectStandardInput = (-not $hasCredential)

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'loom-node.exe did not start.' }

if (-not $hasCredential) {
    # Raw UTF-8 bytes avoid console-codepage corruption under PowerShell 5.1.
    $payload = [Text.Encoding]::UTF8.GetBytes($pairCode + "`n")
    $pairCode = ''
    $delivered = $false
    try {
        $nodeInput = $process.StandardInput.BaseStream
        $nodeInput.Write($payload, 0, $payload.Length)
        $nodeInput.Flush()
        $delivered = $true
    } catch {
        # loom-node may exit before reading stdin; its own diagnosis wins.
        $delivered = $false
    } finally {
        try { $process.StandardInput.Close() } catch { }
        [Array]::Clear($payload, 0, $payload.Length)
        $payload = $null
    }
    if (-not $delivered) {
        [Console]::Error.WriteLine('warning: the pairing code could not be written to loom-node; see its output above.')
    }
}

$process.WaitForExit()
$nodeExit = $process.ExitCode
$process.Dispose()
exit $nodeExit
