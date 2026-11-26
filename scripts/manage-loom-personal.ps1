[CmdletBinding()]
param(
    [ValidateSet('Install', 'Start', 'Portable', 'Rollback', 'Status')]
    [string]$Action = 'Install',
    [string]$PackageDirectory = $PSScriptRoot,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\LOOM-Personal'),
    [string]$DataDirectory,
    [ValidateRange(1024, 65535)][int]$Port = 64852
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'LOOM requires Windows x64.'
}
$utf8 = New-Object Text.UTF8Encoding($false)

function Resolve-Directory([string]$Value) {
    if (-not [IO.Path]::IsPathRooted($Value) -or $Value -match '(^|[\\/])\.\.?([\\/]|$)') {
        throw 'Use an absolute directory without . or .. segments.'
    }
    $resolved = [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
    if ($resolved -eq [IO.Path]::GetPathRoot($resolved).TrimEnd('\', '/')) { throw 'A drive root cannot be used.' }
    $part = $resolved
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            if ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Linked directories are not supported: $part"
            }
        }
        $parent = [IO.Directory]::GetParent($part)
        $part = if ($parent) { $parent.FullName } else { $null }
    }
    return $resolved
}

function Read-Json([string]$Path) {
    $json = [IO.File]::ReadAllText($Path)
    if ($PSVersionTable.PSVersion.Major -ge 6) { return ($json | ConvertFrom-Json -AsHashtable) }
    # A PSCustomObject with thousands of long property names is quadratic on
    # Windows PowerShell 5.1. Use the framework JSON dictionary there.
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = 16777216
    return $serializer.DeserializeObject($json)
}

function File-Hash([string]$Path) {
    $hash = [Security.Cryptography.SHA256]::Create()
    # Windows PowerShell 5.1 still applies MAX_PATH to ordinary FileStream
    # paths. Pi dependencies legitimately exceed it in a Downloads folder.
    $nativePath = if ($Path.StartsWith('\\')) { '\\?\UNC\' + $Path.Substring(2) } else { '\\?\' + $Path }
    $stream = [IO.File]::OpenRead($nativePath)
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
}

function Package-Files([string]$Root) {
    $queue = New-Object 'Collections.Generic.Queue[string]'
    $nativeRoot = if ($Root.StartsWith('\\')) { '\\?\UNC\' + $Root.Substring(2) } else { '\\?\' + $Root }
    $queue.Enqueue($nativeRoot)
    $found = New-Object 'Collections.Generic.List[string]'
    while ($queue.Count) {
        foreach ($path_ in [IO.Directory]::EnumerateFileSystemEntries($queue.Dequeue())) {
            $attributes = [IO.File]::GetAttributes($path_)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Package contains a linked path: $path_"
            }
            if ($attributes -band [IO.FileAttributes]::Directory) { $queue.Enqueue($path_) }
            elseif ($path_.StartsWith('\\?\UNC\')) { $found.Add('\\' + $path_.Substring(8)) }
            else { $found.Add($path_.Substring(4)) }
        }
    }
    # One object, not 33k pipeline items: the closure check walks this list.
    return ,$found
}

# Serial batch hasher used by the parallel closure check. One SHA-256 instance
# per worker, an explicit Initialize() before every file, and the bytes still
# read in full. Nothing here skips a file or trusts a timestamp.
$closureWorker = {
    param([string[]]$Relative, [string[]]$Native, [string[]]$Expected)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $count = 0
    $bytes = 0L
    $damaged = New-Object 'Collections.Generic.List[string]'
    try {
        for ($i = 0; $i -lt $Relative.Count; $i++) {
            $stream = [IO.File]::OpenRead($Native[$i])
            try {
                $bytes += $stream.Length
                $algorithm.Initialize()
                $digest = $algorithm.ComputeHash($stream)
            } finally { $stream.Dispose() }
            if ([BitConverter]::ToString($digest).Replace('-', '') -cne $Expected[$i]) { $damaged.Add($Relative[$i]) }
            $count++
        }
    } finally { $algorithm.Dispose() }
    , @($count, $bytes, $damaged.ToArray())
}

# Full closure check over every file in the package, in parallel batches.
# Every byte of the packaged closure is read and compared to the manifest; the
# only change against the serial version is that the same work is spread over
# ProcessorCount workers instead of one PowerShell statement stream.
function Verify-Closure([string]$Root, $Manifest, $Allowed) {
    $hashes = $Manifest.files
    $relative = New-Object 'Collections.Generic.List[string]'
    $native = New-Object 'Collections.Generic.List[string]'
    $expected = New-Object 'Collections.Generic.List[string]'
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in (Package-Files $Root)) {
        $name = $file.Substring($Root.Length + 1).Replace('\', '/')
        if ($name -eq 'candidate-manifest.json') { continue }
        if (-not $Allowed.Contains($name)) { throw "Unexpected package file: $name" }
        if (-not $hashes.ContainsKey($name)) { throw "Package file list is invalid: $name" }
        $relative.Add($name)
        $native.Add('\\?\' + $file)
        $expected.Add($hashes[$name].ToUpperInvariant())
        [void]$seen.Add($name)
    }
    if ($seen.Count -ne $Allowed.Count) { throw 'Package files are missing. Extract the complete download again.' }
    $degree = [Math]::Min([Math]::Max(1, [Environment]::ProcessorCount), 8)
    $batch = [Math]::Max(64, [int][Math]::Ceiling($relative.Count / ($degree * 4)))
    $batches = New-Object 'Collections.Generic.List[object]'
    for ($start = 0; $start -lt $relative.Count; $start += $batch) {
        $take = [Math]::Min($batch, $relative.Count - $start)
        $batches.Add(@($relative.GetRange($start, $take).ToArray(),
            $native.GetRange($start, $take).ToArray(), $expected.GetRange($start, $take).ToArray()))
    }
    $pool = [runspacefactory]::CreateRunspacePool(1, [Math]::Min($degree, $batches.Count))
    $pool.Open()
    try {
        $handles = New-Object 'Collections.Generic.List[object]'
        foreach ($work in $batches) {
            $shell = [powershell]::Create()
            $shell.RunspacePool = $pool
            [void]$shell.AddScript($closureWorker).AddArgument($work[0]).AddArgument($work[1]).AddArgument($work[2])
            $handles.Add([pscustomobject]@{ Shell = $shell; Handle = $shell.BeginInvoke() })
        }
        $count = 0
        $bytes = 0L
        $damaged = New-Object 'Collections.Generic.List[string]'
        foreach ($item in $handles) {
            try {
                $result = @($item.Shell.EndInvoke($item.Handle))
                if ($result.Count -ne 1) {
                    $detail = if ($item.Shell.Streams.Error.Count) { $item.Shell.Streams.Error[0].ToString() } else { 'no result' }
                    throw "Package verification worker failed: $detail"
                }
                $count += $result[0][0]
                $bytes += $result[0][1]
                if ($result[0][2]) { foreach ($name in $result[0][2]) { $damaged.Add($name) } }
            } finally { $item.Shell.Dispose() }
        }
        if ($damaged.Count) {
            throw "Damaged package file: $($damaged[0])"
        }
        if ($count -ne $Allowed.Count) { throw 'Package files are missing. Extract the complete download again.' }
    } finally {
        $pool.Close()
        $pool.Dispose()
    }
    return $bytes
}

function Verify-Package([string]$Root, [switch]$InstalledStart) {
    $Root = Resolve-Directory $Root
    $manifestPath = Join-Path $Root 'candidate-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Extract the complete LOOM package before installing.' }
    $manifest = Read-Json $manifestPath
    if ($manifest.target -cne 'windows-x64' -or $manifest.commit -cnotmatch '^[0-9a-f]{40}$' -or
        $manifest.qualification -cne 'isolated-personal-development-preview' -or $manifest.dailyDataIncluded) {
        throw 'This is not a supported LOOM personal package.'
    }
    $allowed = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $manifest.files.GetEnumerator()) {
        $relative = $entry.Key
        if ($relative -match '[:\\]' -or [IO.Path]::IsPathRooted($relative) -or
            @($relative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -or
            $entry.Value -cnotmatch '^[0-9a-f]{64}$' -or -not $allowed.Add($relative)) {
            throw 'Package file list is invalid.'
        }
    }
    foreach ($required in @('rovai-server.exe', 'rovai-host.exe', 'rovai-core.exe', 'rovai.exe', 'loom-node.exe',
        'web-ui/index.html', 'Start-Loom.cmd', 'LICENSE')) {
        if (-not $allowed.Contains($required)) { throw "Package is incomplete: $required" }
    }
    if ($manifest.ContainsKey('computerRuntime')) {
        foreach ($required in @('runtime/computer/computer-bundle.json', 'runtime/computer/python/python.exe',
            'runtime/computer/python/python314._pth', 'runtime/computer/host_desktop.py',
            'runtime/computer/mcp_bridge.py', 'runtime/computer/THIRD-PARTY-NOTICES.txt')) {
            if (-not $allowed.Contains($required)) { throw "Computer runtime is incomplete: $required" }
        }
    }
    if ($manifest.ContainsKey('dshHookExecutor')) {
        $hook = $manifest.dshHookExecutor
        foreach ($required in @('runtime/dsh-hook-executor/hook-executor-bundle.json',
            'runtime/dsh-hook-executor/executor.mjs', 'runtime/dsh-hook-executor/verify.mjs',
            'runtime/dsh-hook-executor/package.json', 'runtime/dsh-hook-executor/package-lock.json',
            'runtime/dsh-hook-executor/THIRD-PARTY-NOTICES.txt')) {
            if (-not $allowed.Contains($required)) { throw "DSH Hook runtime is incomplete: $required" }
        }
        if ($hook.manifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $hook.manifestSha256 -cne $manifest.files.'runtime/dsh-hook-executor/hook-executor-bundle.json') {
            throw 'DSH Hook manifest does not match the package file list.'
        }
    }
    if ($InstalledStart) {
        # The whole closure was verified before activation. Recheck entry
        # points on launch without rereading thousands of Pi dependency files.
        $entries = @('rovai-server.exe', 'rovai-core.exe', 'rovai.exe', 'web-ui/index.html') +
            @($allowed | Where-Object { $_.StartsWith('runtime/computer/', [StringComparison]::Ordinal) }) +
            @($allowed | Where-Object {
                $_ -match '^runtime/dsh-hook-executor/(hook-executor-bundle\.json|executor\.mjs|verify\.mjs|package(?:-lock)?\.json|THIRD-PARTY-NOTICES\.txt)$'
            })
        $entries += @('runtime/pi/node/node.exe')
        foreach ($relative in $entries) {
            $file = Resolve-Directory (Join-Path $Root $relative)
            if ((File-Hash $file) -cne $manifest.files[$relative]) { throw "Damaged program file: $relative" }
        }
        return $manifest
    }
    [void](Verify-Closure $Root $manifest $allowed)
    return $manifest
}

function Write-AtomicJson([string]$Path, $Value) {
    $temp = $Path + '.new-' + [Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 8), $utf8)
    try {
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temp, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temp, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temp) { [IO.File]::Delete($temp) }
    }
}

function Read-State([string]$Root) {
    $state = Read-Json (Join-Path $Root 'installation.json')
    if ($state.schema -ne 1 -or $state.current -cnotmatch '^[0-9a-f]{40}$' -or
        ($state.previous -and $state.previous -cnotmatch '^[0-9a-f]{40}$') -or
        ($state.lastStarted -and $state.lastStarted -cnotmatch '^[0-9a-f]{40}$') -or
        $state.port -lt 1024 -or $state.port -gt 65535) { throw 'LOOM installation information is invalid.' }
    [void](Resolve-Directory $state.dataDirectory)
    return $state
}

function Assert-DataSeparate([string]$DataRoot, [string]$ProgramRoot) {
    if ($DataRoot.Equals($ProgramRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $DataRoot.StartsWith($ProgramRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $ProgramRoot.StartsWith($DataRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Keep program files and personal data in separate directories.'
    }
}

function Assert-Stopped([string]$Root) {
    foreach ($process_ in @(Get-Process -Name 'rovai-server', 'rovai-host' -ErrorAction SilentlyContinue)) {
        if ($process_.Path -and $process_.Path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Close this LOOM console before updating or switching versions.'
        }
    }
}

function Data-Contract($Manifest) {
    if (-not $Manifest.ContainsKey('dataContract')) { return $null }
    $value = $Manifest['dataContract']
    if ($value.version -cnotmatch '^[A-Za-z0-9_.-]+$' -or
        ($value.projectionSchema -isnot [int] -and $value.projectionSchema -isnot [long]) -or
        $value.projectionSchema -lt 1) { return $null }
    return "$($value.version):$($value.projectionSchema)"
}

function Run-Loom([string]$Root, [string]$DataRoot, [int]$ListenPort, $Manifest) {
    Assert-DataSeparate $DataRoot $Root
    $env:ROVAI_EMBEDDED_PI_ROOT = Join-Path $Root 'runtime\pi'
    $env:PI_CODING_AGENT_DIR = Join-Path $DataRoot 'runtime-home\pi'
    $env:CODEX_HOME = Join-Path $DataRoot 'runtime-home\codex'
    $env:CLAUDE_CONFIG_DIR = Join-Path $DataRoot 'runtime-home\claude'
    $env:DSH_HOME = Join-Path $DataRoot 'runtime-home\dsh'
    # Host-owned configuration only. The browser still requires independent
    # view/control consent; the assistant bridge still requires its own grant.
    if ($Manifest.ContainsKey('computerRuntime')) {
        $computer = Join-Path $Root 'runtime\computer'
        $env:LOOM_COMPUTER_PYTHON = Join-Path $computer 'python\python.exe'
        $env:LOOM_COMPUTER_HELPER = Join-Path $computer 'host_desktop.py'
        $env:LOOM_COMPUTER_AGENT_PYTHON = $env:LOOM_COMPUTER_PYTHON
        $env:LOOM_COMPUTER_AGENT_BRIDGE = Join-Path $computer 'mcp_bridge.py'
    }
    Write-Host "LOOM: http://127.0.0.1:$ListenPort/"
    Write-Host 'Keep this window open. Press Ctrl+C to stop.'
    Write-Host "Personal data: $DataRoot"
    # The native Server prepares its private data root, Skill library and MCP
    # path. Never create this directory with inherited ACLs in the launcher.
    & (Join-Path $Root 'rovai-server.exe') --data-dir $DataRoot --listen "127.0.0.1:$ListenPort"
    if ($LASTEXITCODE -ne 0) { throw "LOOM could not start (exit $LASTEXITCODE). Your data was kept." }
}

$InstallDirectory = Resolve-Directory $InstallDirectory
if ($Action -in @('Install', 'Portable')) {
    if (-not $PackageDirectory) { $PackageDirectory = $PSScriptRoot }
    $PackageDirectory = Resolve-Directory $PackageDirectory
}
$lease = $null
$incoming = $null
try {
    if ($Action -eq 'Portable') {
        $manifest = Verify-Package $PackageDirectory
        if (-not $DataDirectory) { $DataDirectory = Join-Path $env:LOCALAPPDATA 'LOOM\personal-preview-20261116' }
        Run-Loom $PackageDirectory (Resolve-Directory $DataDirectory) $Port $manifest
        return
    }
    $manifest = if ($Action -eq 'Install') { Verify-Package $PackageDirectory } else { $null }
    $marker = Join-Path $InstallDirectory 'INSTALLER-V1'
    if (Test-Path -LiteralPath $InstallDirectory) {
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
            [IO.File]::ReadAllText($marker).Trim() -cne 'loom-personal') { throw 'Choose a new folder for LOOM. This folder belongs to another installation.' }
    } elseif ($Action -eq 'Install') {
        [void][IO.Directory]::CreateDirectory($InstallDirectory)
        [IO.File]::WriteAllText($marker, "loom-personal`n", $utf8)
    } else { throw 'LOOM is not installed in this folder.' }
    try { $lease = [IO.File]::Open((Join-Path $InstallDirectory '.install-lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'LOOM is running or another installation is in progress. Close its console and try again.' }
    $statePath = Join-Path $InstallDirectory 'installation.json'
    $state = if (Test-Path -LiteralPath $statePath) { Read-State $InstallDirectory } else { $null }

    if ($Action -eq 'Install') {
        Assert-Stopped $InstallDirectory
        if ($state) {
            if ($DataDirectory -and (Resolve-Directory $DataDirectory) -cne $state.dataDirectory) {
                throw 'An upgrade keeps the existing personal data directory.'
            }
            $DataDirectory = $state.dataDirectory
            $Port = $state.port
        } elseif (-not $DataDirectory) { $DataDirectory = Join-Path $env:LOCALAPPDATA 'LOOM\personal-preview-20261116' }
        $DataDirectory = Resolve-Directory $DataDirectory
        Assert-DataSeparate $DataDirectory $InstallDirectory
        Assert-DataSeparate $DataDirectory $PackageDirectory
        Assert-DataSeparate $InstallDirectory $PackageDirectory
        $releases = Join-Path $InstallDirectory 'versions'
        [void][IO.Directory]::CreateDirectory($releases)
        $destination = Join-Path $releases $manifest.commit
        if (Test-Path -LiteralPath $destination) {
            [void](Verify-Package $destination)
            if ((File-Hash (Join-Path $destination 'candidate-manifest.json')) -cne
                (File-Hash (Join-Path $PackageDirectory 'candidate-manifest.json'))) {
                throw 'This source version is already installed with different package contents.'
            }
        } else {
            $incoming = Join-Path $InstallDirectory ('.incoming-' + [Guid]::NewGuid().ToString('N'))
            # Robocopy preserves hidden dependencies and supports long paths
            # on stock Windows; /SL and /XJ never follow links during copying.
            & robocopy.exe $PackageDirectory $incoming /E /COPY:DAT /DCOPY:DAT /SL /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -gt 7) { throw 'Package copy failed. The active version was kept.' }
            [void](Verify-Package $incoming)
            [IO.Directory]::Move($incoming, $destination)
            $incoming = $null
        }
        # Stable entry points never carry account data. All versions remain
        # available until the owner explicitly removes them.
        Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $InstallDirectory 'Manage-Loom.ps1') -Force
        $launcher = "@echo off`r`nsetlocal EnableExtensions`r`npowershell.exe -NoLogo -NoProfile -File `"%~dp0Manage-Loom.ps1`" -Action Start -InstallDirectory `"%~dp0\`"`r`nif errorlevel 1 pause`r`n"
        [IO.File]::WriteAllText((Join-Path $InstallDirectory 'Start-Loom.cmd'), $launcher, $utf8)
        $rollback = $launcher.Replace('-Action Start ', '-Action Rollback ')
        [IO.File]::WriteAllText((Join-Path $InstallDirectory 'Rollback-Loom.cmd'), $rollback, $utf8)
        [IO.File]::WriteAllText((Join-Path $InstallDirectory 'Open-Loom.url'), "[InternetShortcut]`r`nURL=http://127.0.0.1:$Port/`r`n", $utf8)
        $previous = if ($state -and $state.current -ne $manifest.commit) { $state.current } elseif ($state) { $state.previous } else { $null }
        $lastStarted = if ($state) { $state.lastStarted } else { $null }
        $state = [ordered]@{ schema = 1; current = $manifest.commit; previous = $previous; dataDirectory = $DataDirectory; port = $Port; lastStarted = $lastStarted }
        Write-AtomicJson $statePath $state
        Write-Host "LOOM installed. Open: $(Join-Path $InstallDirectory 'Start-Loom.cmd')"
        Write-Host "Personal data: $DataDirectory"
    } elseif ($Action -eq 'Status') {
        if (-not $state) { throw 'LOOM installation did not finish. Run Install-Loom.cmd again.' }
        $state | ConvertTo-Json -Depth 4
    } elseif ($Action -eq 'Rollback') {
        if (-not $state -or -not $state.previous) { throw 'There is no previous version to switch to.' }
        Assert-Stopped $InstallDirectory
        $current = Verify-Package (Join-Path $InstallDirectory "versions\$($state.current)")
        $previous = Verify-Package (Join-Path $InstallDirectory "versions\$($state.previous)")
        # Before a newer build ever starts, switching back cannot downgrade
        # data. Afterwards require the Core's declared data contract to match.
        if ($state.lastStarted -eq $state.current) {
            $currentContract = Data-Contract $current
            $previousContract = Data-Contract $previous
            if (-not $currentContract -or $currentContract -cne $previousContract) {
                throw 'The versions do not declare the same data format. Automatic rollback was not performed; keep both versions and use the verified data migration recovery.'
            }
        }
        $from = $state.current
        $state.current = $state.previous
        $state.previous = $from
        Write-AtomicJson $statePath $state
        Write-Host 'Previous program version selected. Personal data was kept. Open Start-Loom.cmd to continue.'
    } elseif ($Action -eq 'Start') {
        if (-not $state) { throw 'LOOM installation did not finish. Run Install-Loom.cmd again.' }
        $release = Join-Path $InstallDirectory "versions\$($state.current)"
        $selected = Verify-Package $release -InstalledStart
        if ($state.lastStarted -and $state.lastStarted -ne $state.current) {
            $last = Verify-Package (Join-Path $InstallDirectory "versions\$($state.lastStarted)") -InstalledStart
            if ($last.files.'rovai-server.exe' -cne $selected.files.'rovai-server.exe') {
                $selectedContract = Data-Contract $selected
                $lastContract = Data-Contract $last
                if (-not $selectedContract -or -not $lastContract -or
                    $selected.dataContract.projectionSchema -lt $last.dataContract.projectionSchema -or
                    ($selected.dataContract.projectionSchema -eq $last.dataContract.projectionSchema -and $selectedContract -cne $lastContract)) {
                    throw 'This program cannot safely open data from the last-started version. Keep the newer program or use verified migration recovery.'
                }
            }
        }
        $state.lastStarted = $state.current
        Write-AtomicJson $statePath $state
        Run-Loom $release $state.dataDirectory $state.port $selected
    }
} finally {
    if ($incoming -and (Test-Path -LiteralPath $incoming)) {
        try { [IO.Directory]::Delete(('\\?\' + $incoming), $true) }
        catch { Write-Warning "The incomplete copy remains at $incoming. Your active version was kept." }
    }
    if ($lease) { $lease.Dispose() }
}
