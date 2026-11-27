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
if ($nodePath.Contains('"')) { throw 'loom-node.exe path must not contain a double quote.' }
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

$commandLine = '"' + $nodePath + '" --data-dir "' + $dataDirPath + '" --server "' + $serverUrl + '"'
if (-not $hasCredential) { $commandLine = $commandLine + ' --pair-code-stdin' }

if (-not $hasCredential) {
    # PowerShell 5.1's Process.StandardInput emits a UTF-8 BOM before the first
    # byte, which loom-node would read as part of the code. The WScript.Shell
    # Exec pipe writes the bare ASCII line, so the one-time pairing goes there
    # and the node trims the line ending itself.
    $shell = New-Object -ComObject WScript.Shell
    $exec = $shell.Exec($commandLine)
    if ($null -eq $exec) { throw 'loom-node.exe did not start.' }
    try {
        $exec.StdIn.WriteLine($pairCode)
        $exec.StdIn.Close()
    } catch {
        # loom-node may exit before reading stdin; its own diagnosis wins.
        [Console]::Error.WriteLine('warning: the pairing code could not be written to loom-node; see the node output that follows.')
    }
    $pairCode = ''
    # Exec pipes both streams back. Draining stderr first keeps the node's
    # diagnosis flowing and its pipe from filling; stdout follows after exit.
    $nodeError = ''
    try { $nodeError = $exec.StdErr.ReadAll() } catch { }
    if ($nodeError.Length -gt 0) { [Console]::Error.Write($nodeError) }
    $nodeOutput = ''
    try { $nodeOutput = $exec.StdOut.ReadAll() } catch { }
    if ($nodeOutput.Length -gt 0) { [Console]::Out.Write($nodeOutput) }
    while ($exec.Status -eq 0) { Start-Sleep -Milliseconds 50 }
    exit $exec.ExitCode
}

# Reconnect: no stdin needed, so the node inherits this console directly.
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodePath
$startInfo.Arguments = $commandLine
$startInfo.UseShellExecute = $false

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'loom-node.exe did not start.' }

$process.WaitForExit()
$nodeExit = $process.ExitCode
$process.Dispose()
exit $nodeExit
