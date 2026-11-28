#requires -Version 5.1
<#
    Cloud real acceptance - Win11 real machine as the remote node.

    Topology under test: the LOOM Core runs in the Bero cloud (loomcloud compose project,
    cloudflared quick tunnel) and this Windows 11 machine is the remote node that dials
    out to the tunnel. This script NEVER touches the cloud host itself: it only speaks
    the public Web surface of the tunnel URL plus the local node kit.

    Stock Windows PowerShell 5.1 only: no third-party module, no COM object, no class
    syntax, no ternary, no null-coalescing. Every wait is bounded by a parameter and every
    loop has a deadline.

    WRITTEN FOR STATIC REVIEW FIRST. The author did not run it.

    -------------------------------------------------------------------------------
    Public Web operations used by this script (each one is admitted by the repo)
    -------------------------------------------------------------------------------
    crates/rovai-web/src/operations.rs holds the admitted operation enum:
        crates/rovai-web/src/operations.rs:14-15    missions.workspace.prepareRemote
        crates/rovai-web/src/operations.rs:22-23   missions.get
        crates/rovai-web/src/operations.rs:34-35   missions.create
        crates/rovai-web/src/operations.rs:64-65   loom.artifact.preview
        crates/rovai-web/src/operations.rs:276    threads.open   (alias camps.open)
        crates/rovai-web/src/operations.rs:296    app.info
        crates/rovai-web/src/operations.rs:298    members.list
        crates/rovai-web/src/operations.rs:382    thread.messages.send (alias camp.messages.send)
        crates/rovai-web/src/operations.rs:392    pi.modelProvider.get
        crates/rovai-web/src/operations.rs:394    pi.modelProvider.save
        crates/rovai-web/src/operations.rs:404    threads.create (alias camps.create)
        crates/rovai-web/src/operations.rs:464,627  prepareRemote timeout 120 s, method name

    The RPC transport is a single route: POST /api/v1/request {operation, params} that
    answers {result, error} (crates/rovai-web/src/lib.rs:294, 706-760).

    Plain authenticated Web routes used here (there is no RPC operation for them):
      crates/rovai-web/src/lib.rs:328           POST /api/v1/login            (lib.rs:232-240, 42)
      crates/rovai-web/src/lib.rs:313           GET  /api/v1/nodes            (nodes.rs:2067-2075)
      crates/rovai-web/src/lib.rs:317           POST /api/v1/nodes/workspaces (nodes.rs:2343-2359)
      crates/rovai-web/src/lib.rs:318           POST /api/v1/nodes/workspaces/files
                                                (nodes.rs:2539-2664; read = query.op "read")
      crates/rovai-web/src/lib.rs:312           POST /api/v1/attachments      (resources.rs:1088-1120,
                                                owner locator local_attachment_source.rs:136-176)
      crates/rovai-web/src/lib.rs:325           GET  /api/v1/nodes/connect    (the node's own socket)

    The node side of the pair is the product's own kit, never re-implemented here:
      scripts/node/Connect-LoomNode.ps1:1-8,96-131   pairing code = first stdin line only
      scripts/node/Connect-LoomNode.ps1:132-165       the code reaches loom-node over a pipe
      scripts/node/README.md:24-58                    node-pair, first pairing, reconnect

    -------------------------------------------------------------------------------
    How Pi writes the remote workspace (the design this script verifies)
    -------------------------------------------------------------------------------
    Pi is NOT shipped to the Windows node and is not selected as a remote execution
    target: `members.executionTarget.*` admits only claude-code-cli/codex-cli
    (crates/rovai-core/src/remote_execution.rs:107-116) and that selection is about
    running a runtime process on the node, which this acceptance does not need. The Pi
    Run stays on Core and reaches the prepared remote Mission workspace through the one
    managed Core business tool the `workspace_workflow` permission adds:

      crates/rovai-core/src/pi/managed-workflow-tool.ts:59-77
            LOOM_OPERATIONS = loom.workspace.list/read/write and thread.message.send
      crates/rovai-core/src/pi/managed-workflow-tool.ts:124-134
            closed input keys: write = workspaceId/path/data, read = workspaceId/path/
            offset/maxBytes, send = body/to/mentionUser/publicOnly/files
      crates/rovai-core/src/pi/managed-workflow-tool.ts:17-23
            a non-truncated read materializes one run-private copy under ROVAI_RUN_TMP
      crates/rovai-core/src/pi/managed-workflow-tool.ts:609-633
            the teaching text: read the whole file, then pass the returned localFile
            path in thread.message.send files; never invent an output path
      crates/rovai-core/src/application/workspace_rpc.rs:485-518
            an omitted workspaceId is resolved from the authenticated Run: exactly one
            ready REMOTE workspace is used (none => NotFound, several => InvalidRequest)
      crates/rovai-core/src/application/workspace_rpc.rs:150-172
            loom.workspace.read/write decode the same path/offset/maxBytes/data keys
      crates/rovai-core/src/workspace_rpc_authority.rs:91-138
            resolve_mission_remote_workspace selects only n.role='remote' rows
      crates/rovai-core/src/pi/file_grant.rs:24-30,76-79
            `rovai_loom` exists only under loom_file_access = workspace_workflow

    So the instruction asks Pi for: loom.workspace.write(acceptance.docx, base64),
    loom.workspace.read(blob -> localFile), thread.message.send(files=[localFile]).
    The script then checks the two byte streams against each other and against the bytes
    it embedded: the remote acceptance.docx read through /api/v1/nodes/workspaces/files
    must equal the group attachment read through /api/v1/attachments. A timeout or a
    reply without the attachment is a FAIL, never a SKIP.

    `members.executionTarget.get/save` are deliberately not used: they select a remote
    runtime process for a member, which is not how Pi reaches a remote workspace here.

    A `nodes.list` RPC operation does not exist in operations.rs, so the presence check
    uses the product's own authenticated route GET /api/v1/nodes (lib.rs:313) - the very
    route the Web UI's node list uses. Nothing is fabricated.

    -------------------------------------------------------------------------------
    Secrets
    -------------------------------------------------------------------------------
      * Owner token: $env:LOOM_OWNER_TOKEN or -OwnerTokenSecure (SecureString) only.
      * Model credential: $env:OCT_API_KEY only, handed to pi.modelProvider.save, never
        logged (the operation itself answers keyConfigured/keyRevision and never the key:
        crates/rovai-core/src/pi_provider_settings.rs:173-235).
      * Pairing code: $env:LOOM_PAIR_CODE or one stdin line, piped to the child process's
        stdin as raw ASCII bytes. It never enters argv, a file, a log or summary.json.
      * The session Bearer from /api/v1/login is held in memory and redacted from output.

    -------------------------------------------------------------------------------
    Usage (examples; this script was not executed while it was written)
    -------------------------------------------------------------------------------
      $env:LOOM_OWNER_TOKEN = '<owner token from the Bero Host>'
      $env:OCT_API_KEY      = '<oct gateway key>'
      $env:LOOM_PAIR_CODE   = '<one-time pairing code from scripts/acceptance/cloud-real-acceptance.bero.sh>'
      powershell -NoProfile -ExecutionPolicy Bypass -File cloud-real-acceptance.ps1 `
        -CloudBaseUrl https://<name>.trycloudflare.com `
        -NodePackageDir C:\loom-node-kit

    Output: <WorkRoot>\logs\summary.json (+ report.txt) - PASS/FAIL/SKIP per step, op
    results, evidence hashes and durations, with every registered secret redacted.
#>
[CmdletBinding()]
param(
    # The exact https origin the Core advertises as --public-origin. The Host rejects
    # any other Host/Origin pair with origin_not_allowed (crates/rovai-web/src/network.rs:110-120).
    [Parameter(Mandatory = $true)][string]$CloudBaseUrl,
    # Directory holding Connect-LoomNode.ps1, loom-node.exe and rovai.exe.
    [Parameter(Mandatory = $true)][string]$NodePackageDir,
    # Short work root. Expand-Archive, git and the node kit all stay well below MAX_PATH.
    [string]$WorkRoot = (Join-Path $env:SystemDrive 'loomacc'),
    [Security.SecureString]$OwnerTokenSecure = $null,
    # Model wired into the single Pi provider section (pi_provider_settings.rs:21-31).
    [string]$ModelId = 'deepseek-v4.1-flash',
    # Oct gateway origin. Default is the documented Octopus public gateway
    # (scripts/bero/README.md:14) and can be overridden for another region/route.
    [string]$OctBaseUrl = 'https://oct.agent-ai.vip/v1',
    # Member (agent) to configure and address. Empty selects the first listed member.
    [string]$MemberAgentId = '',
    [int]$HttpTimeoutSeconds = 60,
    [int]$LoginTimeoutSeconds = 60,
    [int]$PairTimeoutSeconds = 180,
    [int]$NodeOnlineTimeoutSeconds = 180,
    [int]$NodeOfflineTimeoutSeconds = 120,
    [int]$PrepareTimeoutSeconds = 180,
    # Bound for one Pi turn: the agent Run settling plus the artifact appearing.
    [int]$RunTimeoutSeconds = 600,
    [int]$PollIntervalMilliseconds = 1000,
    # Keep the temporary git repository and the node data directory after the run.
    [switch]$KeepWorkRoot,
    # Also stop the node and try to reconnect once more before the final cleanup.
    [switch]$SkipReconnect
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# TLS 1.2 is the floor for the tunnel: .NET Framework 4.x would otherwise negotiate
# TLS 1.0 for https. No certificate validation is weakened anywhere in this script.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # A host that cannot set the protocol still fails loudly at the first https call.
}

$script:Results = New-Object 'Collections.Generic.List[object]'
$script:Secrets = New-Object 'Collections.Generic.List[string]'
$script:Evidence = [ordered]@{}
$script:Utf8 = New-Object Text.UTF8Encoding($false)
$script:BaseUrl = ''
$script:ConnectUrl = ''
$script:SessionToken = $null
$script:OwnerToken = $null
$script:OctKey = $null
$script:PairCode = ''
$script:Nonce = ''
$script:MemberId = ''
$script:MemberAdapterKind = ''
$script:RemoteWorkspaceId = ''
$script:SentMessageId = ''
$script:MarkerSha256 = ''
$script:NodeIdsBefore = @()
$script:NodePids = New-Object 'Collections.Generic.List[int]'
$script:Launcher = $null
$script:NodeDataDir = $null
$script:GitDir = $null
$script:ThreadId = ''
$script:MissionId = ''
$script:MissionThreadId = ''
$script:NodeId = ''
$script:WorktreePath = ''
$script:MarkerRelative = ''
$script:PiRelative = ''
$script:MarkerBytes = $null
$script:StartedAt = (Get-Date)
$script:LastResultAt = $null
$script:Paths = [ordered]@{ logs = [IO.Path]::GetTempPath() }

# ======================================================================================
# reporting, redaction, small helpers
# ======================================================================================

function Add-Secret([string]$Value) {
    if ($Value -and $Value.Length -ge 8 -and -not $script:Secrets.Contains($Value)) {
        [void]$script:Secrets.Add($Value)
    }
}

function Hide-Secrets([string]$Text) {
    $hidden = [string]$Text
    foreach ($secret in $script:Secrets) {
        $hidden = $hidden.Replace($secret, '[REDACTED]')
    }
    return $hidden
}

function Add-Result([string]$Id, [string]$Status, [string]$Detail) {
    $now = Get-Date
    $sincePrevious = 0
    if ($script:LastResultAt) { $sincePrevious = [int](($now - $script:LastResultAt).TotalMilliseconds) }
    $script:LastResultAt = $now
    $entry = [pscustomobject]@{
        id         = $Id
        status     = $Status
        detail     = Hide-Secrets $Detail
        at         = $now.ToString('o')
        # Work that produced this result: the time since the previous result, so every
        # phase of the run carries its own cost without a second bookkeeping pass.
        durationMs = $sincePrevious
        elapsedMs  = [int](($now - $script:StartedAt).TotalMilliseconds)
    }
    [void]$script:Results.Add($entry)
    Write-Host ('[{0}] {1} ({2} ms): {3}' -f $entry.status, $entry.id, $entry.durationMs, $entry.detail)
}

function Get-Value($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [string]) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Get-Text($Object, [string]$Name) {
    $value = Get-Value $Object $Name
    if ($null -eq $value) { return '' }
    return [string]$value
}

function New-CommandId { return [Guid]::NewGuid().ToString() }

function New-Directory([string]$Path) {
    if (-not [IO.Directory]::Exists($Path)) { [void][IO.Directory]::CreateDirectory($Path) }
    return $Path
}

function Assert-Timeout([string]$Name, [int]$Seconds) {
    # Every timeout has an upper bound so no wait can become an accidental hang.
    if ($Seconds -lt 5 -or $Seconds -gt 3600) {
        throw "$Name must be between 5 and 3600 seconds."
    }
}

function Wait-Until([scriptblock]$Probe, [int]$TimeoutSeconds, [int]$IntervalMilliseconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $value = & $Probe
        if ($value) { return $value }
        Start-Sleep -Milliseconds $IntervalMilliseconds
    }
    return $null
}

function Get-BytesSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($Bytes)
    } finally {
        $sha.Dispose()
    }
    $builder = New-Object Text.StringBuilder
    foreach ($byte in $hash) { [void]$builder.Append($byte.ToString('x2')) }
    return $builder.ToString()
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Edge([string]$Value, [int]$Length) {
    if (-not $Value) { return '' }
    if ($Value.Length -le $Length) { return $Value }
    return $Value.Substring(0, $Length) + '...'
}

# The Host's own error vocabulary, translated into the one action that fixes it.
function Explain-HttpFailure([int]$Status, [string]$Code) {
    $map = @{
        'origin_not_allowed'          = 'the Host rejected this request Origin: --public-origin (PUBLIC_ORIGIN in docker-compose.yml) must equal CloudBaseUrl (network.rs:110-120, docker-compose.yml:19-30)'
        'query_not_allowed'           = 'the Host refuses query strings on API routes; this script sends none (lib.rs:369-376)'
        'session_required'            = 'the Bearer session is missing or expired; re-run the login step'
        'invalid_administrator_token' = 'LOOM_OWNER_TOKEN is not this Host administrator token (lib.rs:672-676)'
        'protocol_incompatible'       = 'HOST_WEB_PROTOCOL_VERSION mismatch; this script speaks version 5 (lib.rs:42,300-305)'
        'node_channel_requires_loopback' = 'the Host only mints pairing codes/accepts nodes when its own listen address is loopback (nodes.rs:2029-2031,2049-2051); the cloud compose sets LISTEN=127.0.0.1:8767 (docker-compose.yml:44)'
        'node_not_found'              = 'the Host never paired this node id, or it was revoked (nodes.rs:2272-2296)'
        'invalid_workspace'           = 'the prepare params or the source root were refused (nodes.rs:2261-2267,2298-2315)'
        'workspace_not_found'         = 'no ready workspace row for that mission on this node (nodes.rs:2557-2562)'
        'node_offline'                = 'the node socket was not connected while the Host asked it to do work (nodes.rs:2488-2500)'
        'path_rejected'               = 'the relative path is not portable for a remote workspace (nodes.rs:2519-2537)'
        'remote_target_adapter_unsupported' = 'only claude-code-cli and codex-cli can be a remote execution target (remote_execution.rs:107-116)'
        'upload_changed_or_session_expired' = 'the uploaded bytes did not match the intent digest/size (uploads.rs:394-399)'
        'attachment_unavailable'      = 'the Host could not read the attachment for this exact owner locator (resources.rs:1088-1120)'
    }
    $hint = ''
    if ($Code -and $map.ContainsKey($Code)) { $hint = $map[$Code] }
    if ($Status -eq 403 -and -not $hint) { $hint = 'the Host refused the request at its boundary (network.rs:110-120)' }
    if ($Status -eq 401 -and -not $hint) { $hint = 'authentication failed or the session expired' }
    return $hint
}

# ======================================================================================
# HTTP: the tunnel origin only, never a loopback shortcut
# ======================================================================================

function Read-ErrorBody($WebException) {
    $response = $null
    if ($WebException -is [System.Net.WebException]) { $response = $WebException.Response }
    if (-not $response) { return '' }
    try {
        $stream = $response.GetResponseStream()
        if (-not $stream) { return '' }
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    } catch { return '' }
}

function Get-ErrorCode([string]$Body) {
    if (-not $Body) { return '' }
    try {
        $parsed = $Body | ConvertFrom-Json
    } catch {
        return ''
    }
    $failure = Get-Value $parsed 'error'
    $code = Get-Text $failure 'code'
    if (-not $code) { $code = Get-Text $parsed 'code' }
    return $code
}

function Invoke-JsonPost([string]$Path, $Body, [int]$TimeoutSeconds) {
    $headers = @{}
    if ($script:SessionToken) { $headers['Authorization'] = "Bearer $script:SessionToken" }
    $json = $Body | ConvertTo-Json -Depth 30 -Compress
    $bytes = $script:Utf8.GetBytes($json)
    try {
        $response = Invoke-WebRequest -Uri ($script:BaseUrl + $Path) -Method Post -UseBasicParsing `
            -TimeoutSec $TimeoutSeconds -ContentType 'application/json; charset=utf-8' `
            -Headers $headers -Body $bytes
        return ($response.Content | ConvertFrom-Json)
    } catch {
        $status = 0
        $body = ''
        if ($_.Exception -is [System.Net.WebException] -and $_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            $body = Read-ErrorBody $_.Exception
        } else {
            throw (Hide-Secrets ('POST {0} transport failure: {1}' -f $Path, $_.Exception.Message))
        }
        $code = Get-ErrorCode $body
        throw (Hide-Secrets ('POST {0} -> HTTP {1} {2} {3} {4}' -f $Path, $status, $code, (Explain-HttpFailure $status $code), (Get-Edge $body 400)))
    }
}

# Binary (octet-stream) POST. Invoke-WebRequest would decode the body as text, so the
# response stream is read directly. The read is capped like every other wait.
function Invoke-BinaryPost([string]$Path, $Body, [int]$TimeoutSeconds, [int]$MaxBytes = 33554432) {
    $url = $script:BaseUrl + $Path
    $request = [Net.HttpWebRequest]::Create($url)
    $request.Method = 'POST'
    $request.ContentType = 'application/json; charset=utf-8'
    $request.Accept = 'application/octet-stream'
    $request.Timeout = $TimeoutSeconds * 1000
    $request.ReadWriteTimeout = $TimeoutSeconds * 1000
    $request.KeepAlive = $false
    if ($script:SessionToken) { $request.Headers.Add('Authorization', "Bearer $script:SessionToken") }
    $json = $Body | ConvertTo-Json -Depth 30 -Compress
    $payload = $script:Utf8.GetBytes($json)
    $request.ContentLength = $payload.Length
    $stream = $request.GetRequestStream()
    try { $stream.Write($payload, 0, $payload.Length) } finally { $stream.Dispose() }
    $response = $null
    try {
        $response = $request.GetResponse()
    } catch [System.Net.WebException] {
        $status = 0
        $body = ''
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            $body = Read-ErrorBody $_.Exception
        }
        $code = Get-ErrorCode $body
        throw (Hide-Secrets ('POST {0} -> HTTP {1} {2} {3}' -f $Path, $status, $code, (Explain-HttpFailure $status $code)))
    }
    try {
        $memory = New-Object IO.MemoryStream
        $buffer = New-Object byte[] 65536
        $responseStream = $response.GetResponseStream()
        try {
            while ($true) {
                $read = $responseStream.Read($buffer, 0, $buffer.Length)
                if ($read -le 0) { break }
                $memory.Write($buffer, 0, $read)
                if ($memory.Length -gt $MaxBytes) {
                    throw (Hide-Secrets ('POST {0} answered more than {1} bytes' -f $Path, $MaxBytes))
                }
            }
        } finally {
            $responseStream.Dispose()
        }
        return $memory.ToArray()
    } finally {
        $response.Dispose()
    }
}

function Try-CoreRequest([string]$Operation, $Params, [int]$TimeoutSeconds) {
    $body = [ordered]@{ operation = $Operation; params = $Params }
    try {
        $response = Invoke-JsonPost -Path '/api/v1/request' -Body $body -TimeoutSeconds $TimeoutSeconds
    } catch {
        $message = Hide-Secrets $_.Exception.Message
        # A refused operation still has to name its Host administrative code in evidence.
        $code = 'transport'
        if ($message -match 'HTTP (\d{3}) (\S+)') { $code = $Matches[2] }
        return @{ Ok = $false; Status = 'http'; Code = $code; Message = $message; Result = $null }
    }
    $failure = Get-Value $response 'error'
    if ($failure) {
        return @{
            Ok      = $false
            Status  = 200
            Code    = (Get-Text $failure 'code')
            Message = (Hide-Secrets (Get-Text $failure 'message'))
            Result  = $null
        }
    }
    return @{ Ok = $true; Status = 200; Code = $null; Message = $null; Result = (Get-Value $response 'result') }
}

function Invoke-CoreRequest([string]$Operation, $Params, [int]$TimeoutSeconds) {
    $reply = Try-CoreRequest $Operation $Params $TimeoutSeconds
    if (-not $reply.Ok) {
        throw (Hide-Secrets ('operation {0} failed: {1}' -f $Operation, $reply.Message))
    }
    return $reply.Result
}

function Invoke-JsonRoute([string]$Method, [string]$Path, $Body, [int]$TimeoutSeconds) {
    $headers = @{}
    if ($script:SessionToken) { $headers['Authorization'] = "Bearer $script:SessionToken" }
    $arguments = @{
        Uri             = $script:BaseUrl + $Path
        Method          = $Method
        UseBasicParsing = $true
        TimeoutSec      = $TimeoutSeconds
        Headers         = $headers
    }
    if ($null -ne $Body) {
        $arguments['ContentType'] = 'application/json; charset=utf-8'
        $arguments['Body'] = $script:Utf8.GetBytes(($Body | ConvertTo-Json -Depth 30 -Compress))
    }
    try {
        $response = Invoke-WebRequest @arguments
    } catch {
        $status = 0
        $raw = ''
        if ($_.Exception -is [System.Net.WebException] -and $_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            $raw = Read-ErrorBody $_.Exception
        } else {
            throw (Hide-Secrets ('{0} {1} transport failure: {2}' -f $Method, $Path, $_.Exception.Message))
        }
        $code = Get-ErrorCode $raw
        throw (Hide-Secrets ('{0} {1} -> HTTP {2} {3} {4}' -f $Method, $Path, $status, $code, (Explain-HttpFailure $status $code)))
    }
    if (-not $response.Content) { return $null }
    return ($response.Content | ConvertFrom-Json)
}

# ======================================================================================
# Office: a real docx package, entries always forward-slash
# ======================================================================================

function Add-ZipTextEntry($Archive, [string]$Name, [string]$Text) {
    if ($Name.Contains('\')) { throw "zip entry names must use forward slashes: $Name" }
    $entry = $Archive.CreateEntry($Name, [IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    try {
        $bytes = $script:Utf8.GetBytes($Text)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally {
        $stream.Dispose()
    }
}

function New-DocxBytes([string]$Text) {
    Add-Type -AssemblyName System.IO.Compression | Out-Null
    $escaped = [System.Security.SecurityElement]::Escape($Text)
    $memory = New-Object IO.MemoryStream
    $archive = New-Object IO.Compression.ZipArchive($memory, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        Add-ZipTextEntry $archive '[Content_Types].xml' (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
            '</Types>')
        Add-ZipTextEntry $archive '_rels/.rels' (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
            '</Relationships>')
        Add-ZipTextEntry $archive 'word/document.xml' (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
            "<w:p><w:r><w:t>$escaped</w:t></w:r></w:p><w:sectPr/></w:body></w:document>")
    } finally {
        $archive.Dispose()
    }
    try {
        return $memory.ToArray()
    } finally {
        $memory.Dispose()
    }
}

function Get-OoxmlText([byte[]]$Bytes, [string]$EntryName) {
    Add-Type -AssemblyName System.IO.Compression | Out-Null
    $memory = New-Object IO.MemoryStream($Bytes, $false)
    $archive = New-Object IO.Compression.ZipArchive($memory, [IO.Compression.ZipArchiveMode]::Read)
    try {
        $entry = $archive.GetEntry($EntryName)
        if (-not $entry) { return $null }
        $reader = New-Object IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8)
        try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally {
        $archive.Dispose()
        $memory.Dispose()
    }
    $text = [regex]::Replace($xml, '<[^>]+>', ' ')
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    return ([regex]::Replace($text, '\s+', ' ')).Trim()
}

# ======================================================================================
# node kit: pairing code over stdin, only our own PIDs are ever stopped
# ======================================================================================

function Get-NodeProcessIds {
    return @(Get-Process -Name 'loom-node' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}

function Assert-NodePackage {
    if (-not [IO.Directory]::Exists($NodePackageDir)) {
        throw "NodePackageDir does not exist: $NodePackageDir"
    }
    foreach ($name in @('Connect-LoomNode.ps1', 'loom-node.exe', 'rovai.exe')) {
        $path = Join-Path $NodePackageDir $name
        if (-not [IO.File]::Exists($path)) {
            throw "the node kit is incomplete: $name is missing from $NodePackageDir"
        }
    }
}

function ConvertTo-ConnectUrl([string]$Base) {
    $trimmed = $Base.Trim().TrimEnd('/')
    if ($trimmed -match '\s') { throw 'CloudBaseUrl must not contain whitespace.' }
    $uri = $null
    if (-not [Uri]::TryCreate($trimmed, [UriKind]::Absolute, [ref]$uri)) {
        throw 'CloudBaseUrl must be an absolute http(s) URL.'
    }
    if ($uri.Query -or $uri.Fragment) { throw 'CloudBaseUrl must not carry a query or fragment.' }
    $scheme = $uri.Scheme.ToLowerInvariant()
    if ($scheme -eq 'https') {
        return 'wss://' + $uri.Authority + '/api/v1/nodes/connect'
    }
    if ($scheme -eq 'http') {
        $hostName = $uri.Host.ToLowerInvariant()
        if (@('localhost', '127.0.0.1', '::1') -notcontains $hostName) {
            throw 'A plaintext http origin is only accepted for a loopback host; the tunnel must be https.'
        }
        return 'ws://' + $uri.Authority + '/api/v1/nodes/connect'
    }
    throw 'CloudBaseUrl must be http:// or https://.'
}

function Start-NodeLauncher([string]$PairCode) {
    # The product kit runs the node in the foreground, so it is our child process for
    # the whole run. Its stdout/stderr stay on this console (the node's own diagnosis);
    # only stdin is redirected, so the one-time code can be piped instead of typed.
    $kit = Join-Path $NodePackageDir 'Connect-LoomNode.ps1'
    $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $kit + '" -Server "' + $script:ConnectUrl + '" -DataDir "' + $script:NodeDataDir + '"'
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'powershell.exe'
    $startInfo.Arguments = $arguments
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.CreateNoWindow = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'Connect-LoomNode.ps1 did not start.' }

    # The pipe is written through the child's raw stream, never through
    # Process.StandardInput's StreamWriter: PowerShell 5.1's writer can emit a UTF-8 BOM
    # before the first byte (scripts/node/Connect-LoomNode.ps1:132-140 records exactly
    # that), and the kit reads the first line verbatim. Writing bare ASCII bytes keeps
    # the code out of argv, files, the environment and every log.
    if ($PairCode) {
        foreach ($character in $PairCode.ToCharArray()) {
            if ([char]::IsControl($character) -or [int]$character -gt 126) {
                throw 'The pairing code must be printable ASCII.'
            }
        }
    }
    $stdin = $process.StandardInput.BaseStream
    try {
        if ($PairCode) {
            $bytes = [Text.Encoding]::ASCII.GetBytes($PairCode + "`n")
            $stdin.Write($bytes, 0, $bytes.Length)
            $stdin.Flush()
        }
    } finally {
        $stdin.Dispose()
    }
    return $process
}

# Only processes that appeared after a recorded baseline belong to this script. A node the
# user runs by hand is never selected and never stopped.
function Add-NewNodePids([int[]]$Baseline) {
    $added = 0
    foreach ($id in (Get-NodeProcessIds)) {
        if ($Baseline -contains $id) { continue }
        if ($script:NodePids.Contains($id)) { continue }
        [void]$script:NodePids.Add($id)
        $added = $added + 1
    }
    return $added
}

function Stop-OurNode {
    # Only the launcher this script started and the node PIDs it produced are stopped.
    # Nothing is selected by image name, so a node the user runs by hand is never touched.
    $launcher = $script:Launcher
    if ($launcher -and -not $launcher.HasExited) {
        & taskkill.exe /PID $launcher.Id /T /F | Out-Null
        try { Wait-Process -Id $launcher.Id -Timeout 30 -ErrorAction SilentlyContinue } catch { }
    }
    foreach ($id in $script:NodePids) {
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        }
    }
    $remaining = New-Object 'Collections.Generic.List[int]'
    foreach ($id in $script:NodePids) {
        if (Get-Process -Id $id -ErrorAction SilentlyContinue) { [void]$remaining.Add($id) }
    }
    $script:Launcher = $null
    return @{ Stopped = $script:NodePids.Count; Alive = $remaining.ToArray() }
}

# ======================================================================================
# node presence: the product's own authenticated node list
# ======================================================================================

function Get-NodeList {
    $body = Invoke-JsonRoute -Method 'Get' -Path '/api/v1/nodes' -Body $null -TimeoutSeconds $HttpTimeoutSeconds
    return @(Get-Value $body 'nodes')
}

# For polling only: a transport blip reads as "not there yet" and never as success. The
# last failure is kept as evidence so a timeout is explainable.
function Try-NodeList {
    try {
        return (Get-NodeList)
    } catch {
        $script:Evidence['nodeListLastError'] = Hide-Secrets $_.Exception.Message
        return @()
    }
}

function Find-RemoteNode($Nodes, [string]$NodeId) {
    foreach ($node in $Nodes) {
        if (-not $node) { continue }
        $role = Get-Text $node 'role'
        if ($role -eq 'local') { continue }
        if ($NodeId) {
            if ((Get-Text $node 'nodeId') -eq $NodeId) { return $node }
            continue
        }
        if ((Get-Text $node 'status') -eq 'online') { return $node }
    }
    return $null
}

# ======================================================================================
# steps
# ======================================================================================

function Assert-Inputs {
    if (-not [IO.Path]::IsPathRooted($WorkRoot)) { throw 'WorkRoot must be an absolute path.' }
    $root = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
    if ($root.Length -gt 40) { throw "WorkRoot must stay short for git and the node kit: $($root.Length) characters" }
    if ($root -match '(^|\\)\.\.?(\\|$)') { throw 'WorkRoot must not contain . or .. segments.' }
    $script:Paths['work'] = New-Directory $root
    foreach ($name in @('logs', 'repo', 'node')) {
        $script:Paths[$name] = New-Directory (Join-Path $root $name)
    }
    $script:NodeDataDir = $script:Paths['node']
    $script:GitDir = $script:Paths['repo']

    $script:BaseUrl = $CloudBaseUrl.Trim().TrimEnd('/')
    $script:ConnectUrl = ConvertTo-ConnectUrl $CloudBaseUrl

    # Owner token: the process environment or a SecureString parameter, nothing else.
    $token = ''
    if ($OwnerTokenSecure) {
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($OwnerTokenSecure)
        try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
        Add-Result 'TOKEN_INPUT' 'PASS' 'owner token supplied as a SecureString parameter (never written anywhere)'
    } elseif ($env:LOOM_OWNER_TOKEN -and $env:LOOM_OWNER_TOKEN.Trim().Length -gt 0) {
        $token = $env:LOOM_OWNER_TOKEN.Trim()
        Add-Result 'TOKEN_INPUT' 'PASS' 'owner token read from LOOM_OWNER_TOKEN (value never recorded)'
    } else {
        Add-Result 'TOKEN_INPUT' 'FAIL' 'neither -OwnerTokenSecure nor LOOM_OWNER_TOKEN supplies the owner token'
        throw 'FAIL_FAST: the owner token is missing.'
    }
    Add-Secret $token
    $script:OwnerToken = $token
    $token = $null

    Assert-NodePackage
    Add-Result 'NODE_KIT' 'PASS' "Connect-LoomNode.ps1, loom-node.exe and rovai.exe found in $NodePackageDir"

    $credentialPath = Join-Path $script:NodeDataDir 'node.json'
    $hasCredential = [IO.File]::Exists($credentialPath)
    $pairCode = ''
    if ($hasCredential) {
        Add-Result 'PAIR_CODE' 'SKIP' "the node already holds a credential ($credentialPath); the kit reconnects without a pairing code (scripts/node/README.md:52-62)"
    } elseif ($env:LOOM_PAIR_CODE -and $env:LOOM_PAIR_CODE.Trim().Length -gt 0) {
        $pairCode = $env:LOOM_PAIR_CODE.Trim()
        Add-Result 'PAIR_CODE' 'PASS' 'one-time pairing code read from LOOM_PAIR_CODE (value never recorded)'
    } elseif ([Console]::IsInputRedirected) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { throw 'the pairing code was not found on the first stdin line.' }
        $pairCode = $line.Trim()
        Add-Result 'PAIR_CODE' 'PASS' 'one-time pairing code read from the first stdin line (value never recorded)'
    } else {
        $secure = Read-Host -AsSecureString -Prompt 'One-time pairing code'
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $pairCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
        $secure.Dispose()
        if ($pairCode.Length -eq 0) { throw 'the pairing code is empty.' }
        Add-Result 'PAIR_CODE' 'PASS' 'one-time pairing code read from a hidden prompt (value never recorded)'
    }
    if ($pairCode) {
        Add-Secret $pairCode
        $script:PairCode = $pairCode
    }
    $pairCode = $null

    # Model credential: environment only, registered for redaction, then dropped.
    $oct = $env:OCT_API_KEY
    if (-not $oct -or $oct.Trim().Length -eq 0) {
        Add-Result 'OCT_KEY' 'FAIL' 'OCT_API_KEY is not set in this process; the Pi provider cannot be configured'
        throw 'FAIL_FAST: OCT_API_KEY is missing.'
    }
    Add-Secret $oct
    $script:OctKey = $oct
    $oct = $null
    Add-Result 'OCT_KEY' 'PASS' 'OCT_API_KEY present in the process environment (value never recorded)'
}

function Connect-Owner {
    $reply = Invoke-JsonPost -Path '/api/v1/login' -Body ([ordered]@{
            protocolVersion    = 5
            administratorToken = $script:OwnerToken
        }) -TimeoutSeconds $LoginTimeoutSeconds
    $session = Get-Text $reply 'token'
    if (-not $session) { throw 'administrator login returned no Bearer token.' }
    $script:SessionToken = $session
    Add-Secret $session
    $protocolVersion = Get-Value $reply 'protocolVersion'
    $script:Evidence['login'] = [ordered]@{
        protocolVersion = $protocolVersion
        ownerId         = Get-Value $reply 'ownerId'
        clientId        = Get-Text $reply 'clientId'
        channels        = Get-Text $reply 'channels'
        epoch           = Get-Text $reply 'epoch'
        fileTransfers   = Get-Value $reply 'fileTransfers'
    }
    if ($null -ne $protocolVersion -and [int]$protocolVersion -ne 5) {
        throw "the Host answered protocol version $protocolVersion, this script speaks 5 (crates/rovai-web/src/lib.rs:42)."
    }
    Add-Result 'LOGIN' 'PASS' 'owner token accepted by POST /api/v1/login (lib.rs:328)'
}

function Read-AppInfo {
    $info = Invoke-CoreRequest 'app.info' ([ordered]@{}) $HttpTimeoutSeconds
    $script:Evidence['app'] = [ordered]@{
        name    = Get-Text $info 'name'
        version = Get-Text $info 'version'
    }
    Add-Result 'APP_INFO' 'PASS' ("Host {0} {1}" -f (Get-Text $info 'name'), (Get-Text $info 'version'))
}

function Set-PiProvider {
    $before = Invoke-CoreRequest 'pi.modelProvider.get' ([ordered]@{}) $HttpTimeoutSeconds
    $revision = Get-Value $before 'keyRevision'
    $script:Evidence['piProviderBefore'] = [ordered]@{
        status         = Get-Text $before 'status'
        providerId     = Get-Text $before 'providerId'
        baseUrl        = Get-Text $before 'baseUrl'
        modelId        = Get-Text $before 'modelId'
        modelIds       = @(Get-Value $before 'modelIds')
        apiKeyEnv      = Get-Text $before 'apiKeyEnv'
        keyConfigured  = Get-Value $before 'keyConfigured'
        keyRevision    = $revision
        keyLast4       = 'not read: the answer names it, this script does not record it'
    }
    if ($revision -eq $null) { throw 'pi.modelProvider.get returned no keyRevision.' }
    Add-Result 'PI_PROVIDER_GET' 'PASS' ("keyRevision {0}; current model '{1}'" -f $revision, (Get-Text $before 'modelId'))

    # The key travels in the operation params and is replaced by "$OCT_API_KEY" in
    # models.json; Core stores it encrypted (pi_provider_settings.rs:252-267,334-353).
    $saved = Invoke-CoreRequest 'pi.modelProvider.save' ([ordered]@{
            baseUrl     = $OctBaseUrl
            modelId     = $ModelId
            apiKey      = $script:OctKey
            keyRevision = $revision
        }) $HttpTimeoutSeconds
    $script:Evidence['piProviderAfter'] = [ordered]@{
        status        = Get-Text $saved 'status'
        providerId    = Get-Text $saved 'providerId'
        baseUrl       = Get-Text $saved 'baseUrl'
        api           = Get-Text $saved 'api'
        modelId       = Get-Text $saved 'modelId'
        modelIds      = @(Get-Value $saved 'modelIds')
        apiKeyEnv     = Get-Text $saved 'apiKeyEnv'
        keyConfigured = Get-Value $saved 'keyConfigured'
        keyRevision   = Get-Value $saved 'keyRevision'
    }
    if ((Get-Text $saved 'apiKeyEnv') -ne 'OCT_API_KEY') {
        throw "pi.modelProvider.save did not bind the key to OCT_API_KEY (got '$(Get-Text $saved 'apiKeyEnv')')."
    }
    if ((Get-Text $saved 'modelId') -ne $ModelId) {
        throw "pi.modelProvider.save stored model '$(Get-Text $saved 'modelId')' instead of '$ModelId'."
    }
    if ((Get-Value $saved 'keyConfigured') -ne $true) {
        throw 'pi.modelProvider.save answered keyConfigured=false.'
    }
    $script:OctKey = $null
    Add-Result 'PI_PROVIDER_SAVE' 'PASS' ("provider '{0}' -> {1} / model {2}, key held as `$OCT_API_KEY" -f (Get-Text $saved 'providerId'), (Get-Text $saved 'baseUrl'), $ModelId)
}

function Select-Member {
    $members = @(Invoke-CoreRequest 'members.list' ([ordered]@{}) $HttpTimeoutSeconds)
    if ($members.Count -eq 0) { throw 'members.list returned no assistant.' }
    $chosen = $null
    if ($MemberAgentId) {
        foreach ($member in $members) {
            if ((Get-Text $member 'agentId') -eq $MemberAgentId) { $chosen = $member }
        }
        if (-not $chosen) { throw "members.list has no member '$MemberAgentId'." }
    } else {
        $chosen = $members[0]
    }
    $script:MemberId = Get-Text $chosen 'agentId'
    $runtime = Get-Value $chosen 'runtimeConfiguration'
    $script:MemberAdapterKind = Get-Text $runtime 'adapterKind'
    $permissionValues = Get-Value (Get-Value $runtime 'permissions') 'values'
    $fileAccess = Get-Text $permissionValues 'loom_file_access'
    $script:Evidence['member'] = [ordered]@{
        agentId       = $script:MemberId
        displayName   = Get-Text $chosen 'displayName'
        adapterKind   = $script:MemberAdapterKind
        modelId       = Get-Text (Get-Value $runtime 'model') 'modelId'
        readiness     = Get-Text (Get-Value $chosen 'runtimeReadiness') 'status'
        loomFileAccess = $fileAccess
    }
    Add-Result 'MEMBER' 'PASS' ("member {0} ('{1}') adapter '{2}'" -f $script:MemberId, (Get-Text $chosen 'displayName'), $script:MemberAdapterKind)

    # Pi writes the remote workspace only through the managed business tool, and that tool
    # exists only under loom_file_access = workspace_workflow
    # (crates/rovai-core/src/pi/file_grant.rs:24-30,76-79). This is a precondition of the
    # step under test, so a wrong mode is a FAIL with the exact setting to fix - not a SKIP,
    # and the run continues so the rest of the chain still produces its own evidence.
    if ($script:MemberAdapterKind -ne 'pi') {
        Add-Result 'MEMBER_PI_POLICY' 'FAIL' ("the member adapter is '{0}'; this acceptance configures the single Pi provider section and needs a pi member" -f $script:MemberAdapterKind)
    } elseif ($fileAccess -ne 'workspace_workflow') {
        Add-Result 'MEMBER_PI_POLICY' 'FAIL' ("loom_file_access is '{0}', not 'workspace_workflow': rovai_loom (loom.workspace.write/read, thread.message.send) is not granted to this Run (pi/file_grant.rs:24-30,76-79; managed-workflow-tool.ts:59-77)" -f $fileAccess)
    } else {
        Add-Result 'MEMBER_PI_POLICY' 'PASS' 'loom_file_access = workspace_workflow, so the managed rovai_loom tool (loom.workspace.write/read, thread.message.send) is granted'
    }
}

function Start-Node {
    $baseline = Get-NodeProcessIds
    $launcher = Start-NodeLauncher $script:PairCode
    $script:Launcher = $launcher
    $script:PairCode = $null
    $started = Wait-Until -TimeoutSeconds $PairTimeoutSeconds -IntervalMilliseconds $PollIntervalMilliseconds -Probe {
        [void](Add-NewNodePids $baseline)
        if ($launcher.HasExited) { return 'exited' }
        if ($script:NodePids.Count -gt 0) { return 'started' }
        return $null
    }
    [void](Add-NewNodePids $baseline)
    if ($started -eq 'exited') {
        Add-Result 'NODE_PAIR' 'FAIL' ("Connect-LoomNode.ps1 exited with code {0} before loom-node stayed up (its own output above is the diagnosis)" -f $launcher.ExitCode)
        throw 'the node launcher exited during pairing.'
    }
    if ($script:NodePids.Count -eq 0) {
        Add-Result 'NODE_PAIR' 'FAIL' 'Connect-LoomNode.ps1 started but no loom-node process appeared'
        throw 'no loom-node process appeared.'
    }
    $script:Evidence['nodeProcesses'] = [ordered]@{
        launcherPid = $launcher.Id
        nodePids    = @($script:NodePids)
    }
    Add-Result 'NODE_PAIR' 'PASS' ("Connect-LoomNode.ps1 started loom-node pid(s) {0} against {1}" -f (($script:NodePids -join ',')), $script:ConnectUrl)
}

function Wait-NodeOnline([string[]]$KnownBefore) {
    $node = Wait-Until -TimeoutSeconds $NodeOnlineTimeoutSeconds -IntervalMilliseconds $PollIntervalMilliseconds -Probe {
        if ($script:Launcher -and $script:Launcher.HasExited) { return $null }
        $nodes = Try-NodeList
        if ($script:NodeId) { return (Find-RemoteNode $nodes $script:NodeId) }
        # This run paired a node, so the online remote node that was not in the list
        # before the launcher started is the one under test. Anything else stays a
        # refusal instead of an arbitrary pick.
        $candidate = $null
        $count = 0
        foreach ($item in $nodes) {
            if (-not $item) { continue }
            if ((Get-Text $item 'role') -eq 'local') { continue }
            if ((Get-Text $item 'status') -ne 'online') { continue }
            $count = $count + 1
            if ($KnownBefore -notcontains (Get-Text $item 'nodeId')) { $candidate = $item }
        }
        if ($candidate) { return $candidate }
        if ($count -eq 1) { return $candidate }
        return $null
    }
    if (-not $node) {
        Add-Result 'NODE_ONLINE' 'FAIL' ("no remote node reported status=online within {0}s (GET /api/v1/nodes, lib.rs:313)" -f $NodeOnlineTimeoutSeconds)
        throw 'the node never reported online.'
    }
    $script:NodeId = Get-Text $node 'nodeId'
    $clis = @(Get-Value $node 'clis')
    $adapterKinds = New-Object 'Collections.Generic.List[string]'
    foreach ($cli in $clis) {
        if ($cli) { [void]$adapterKinds.Add((Get-Text $cli 'adapterKind')) }
    }
    $script:Evidence['node'] = [ordered]@{
        nodeId        = $script:NodeId
        displayName   = Get-Text $node 'displayName'
        role          = Get-Text $node 'role'
        status        = Get-Text $node 'status'
        os            = Get-Text $node 'os'
        arch          = Get-Text $node 'arch'
        pairedAt      = Get-Text $node 'pairedAt'
        lastHeartbeat = Get-Text $node 'lastHeartbeat'
        reportedClis  = $adapterKinds.ToArray()
    }
    Add-Result 'NODE_ONLINE' 'PASS' ("node {0} is online ({1} {2})" -f $script:NodeId, (Get-Text $node 'os'), (Get-Text $node 'arch'))
}

function New-Thread {
    $created = Invoke-CoreRequest 'threads.create' ([ordered]@{
            commandId         = New-CommandId
            name              = 'Cloud acceptance ' + (Get-Date).ToString('yyyyMMdd-HHmmss')
            workspace         = $null
            memberAgentIds    = @($script:MemberId)
            defaultLeadAgentId = $script:MemberId
            collaborationMode = 'peer'
        }) $HttpTimeoutSeconds
    $status = Get-Text $created 'status'
    $threadId = Get-Text (Get-Value $created 'payload') 'threadId'
    if ($status -ne 'applied' -or -not $threadId) { throw "threads.create was not applied: $status" }
    $script:ThreadId = $threadId
    $script:Evidence['thread'] = [ordered]@{ threadId = $threadId; createStatus = $status }
    Add-Result 'THREAD_CREATE' 'PASS' "created group $threadId (operations.rs:404, Core application.rs:11667-11715)"
}

function Initialize-GitDirectory {
    $git = Get-Command 'git' -ErrorAction SilentlyContinue
    if (-not $git) {
        Add-Result 'GIT_DIR' 'SKIP' 'git.exe is not on PATH; the node prepare needs a real work tree (loom-protocol/src/workspace.rs:217-263)'
        return $false
    }
    if ([IO.Directory]::Exists($script:GitDir)) {
        Get-ChildItem -LiteralPath $script:GitDir -Force -Recurse -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
    [void](New-Directory $script:GitDir)
    $readme = Join-Path $script:GitDir 'README.md'
    [IO.File]::WriteAllText($readme, "# Cloud real acceptance source`r`n", $script:Utf8)
    $steps = New-Object 'Collections.Generic.List[object]'
    $run = {
        param([string[]]$GitArgs)
        $output = & $git.Source @GitArgs 2>&1
        $code = $LASTEXITCODE
        [void]$steps.Add([ordered]@{ args = ($GitArgs -join ' '); exit = $code; output = (Get-Edge ((@($output) -join ' ') -replace '\s+', ' ') 200) })
        if ($code -ne 0) { throw ("git {0} exited {1}: {2}" -f ($GitArgs -join ' '), $code, (@($output) -join ' ')) }
    }
    & $run @('-C', $script:GitDir, 'init')
    & $run @('-C', $script:GitDir, 'add', '--all')
    & $run @('-C', $script:GitDir, '-c', 'user.name=Loom cloud acceptance', '-c', 'user.email=acceptance@loom.local',
        'commit', '-m', 'Cloud real acceptance fixture')
    $head = (& $git.Source @('-C', $script:GitDir, 'rev-parse', 'HEAD')) -join ''
    $head = $head.Trim()
    if ($head.Length -lt 7) { throw 'the temporary git repository has no HEAD commit.' }
    $script:Evidence['git'] = [ordered]@{
        directory = $script:GitDir
        headSha   = $head
        steps     = $steps.ToArray()
    }
    Add-Result 'GIT_DIR' 'PASS' "real git repository at $($script:GitDir) with HEAD $head"
    return $true
}

function New-Mission {
    # missions.create also creates the Mission's own Thread (mission.rs:451-466); the
    # project binding is quick_chat so Core substitutes its own data-dir child path
    # instead of judging a Windows path it cannot see (application/mission.rs:1294-1298).
    $created = Invoke-CoreRequest 'missions.create' ([ordered]@{
            commandId = New-CommandId
            command   = [ordered]@{
                title               = 'Cloud real acceptance ' + (Get-Date).ToString('yyyyMMdd-HHmmss')
                description         = 'Cloud Core on Bero with this Windows machine as the remote node.'
                projectPath         = 'quick-chat'
                projectBindingKind  = 'quick_chat'
                memberAgentIds      = @($script:MemberId)
                defaultLeadAgentId  = $script:MemberId
                tags                = @('acceptance', 'cloud-real')
            }
        }) $HttpTimeoutSeconds
    $status = Get-Text $created 'status'
    $payload = Get-Value $created 'payload'
    $missionId = Get-Text $payload 'missionId'
    $threadId = Get-Text $payload 'threadId'
    if ($status -ne 'applied' -or -not $missionId -or -not $threadId) {
        throw "missions.create was not applied: $status ($(Get-Text $created 'code'))"
    }
    $script:MissionId = $missionId
    $script:MissionThreadId = $threadId
    $script:Evidence['mission'] = [ordered]@{
        missionId     = $missionId
        missionNumber = Get-Value $payload 'missionNumber'
        threadId      = $threadId
        createStatus  = $status
    }
    Add-Result 'MISSION_CREATE' 'PASS' "mission $missionId in new thread $threadId (operations.rs:34, mission.rs:427-479)"
}

function Invoke-PrepareRemote {
    $reply = Try-CoreRequest 'missions.workspace.prepareRemote' ([ordered]@{
            missionId  = $script:MissionId
            nodeId     = $script:NodeId
            sourceRoot = $script:GitDir
        }) $PrepareTimeoutSeconds
    if (-not $reply.Ok) {
        Add-Result 'PREPARE_REMOTE' 'FAIL' ("missions.workspace.prepareRemote failed: {0}" -f $reply.Message)
        throw $reply.Message
    }
    $workspace = $reply.Result
    $ownerRole = Get-Text $workspace 'ownerRole'
    $worktree = Get-Text $workspace 'worktree'
    $branch = Get-Text $workspace 'branch'
    $baseSha = Get-Text $workspace 'baseSha'
    $script:Evidence['preparedWorkspace'] = [ordered]@{
        missionId = Get-Text $workspace 'missionId'
        campId    = Get-Text $workspace 'campId'
        nodeId    = Get-Text $workspace 'nodeId'
        ownerRole = $ownerRole
        worktree  = $worktree
        source    = Get-Text $workspace 'source'
        branch    = $branch
        baseSha   = $baseSha
    }
    if ((Get-Text $workspace 'nodeId') -ne $script:NodeId) {
        throw "the prepared row names node '$(Get-Text $workspace 'nodeId')' instead of '$script:NodeId'."
    }
    if ($ownerRole -ne 'remote') {
        throw "the prepared row ownerRole is '$ownerRole', not 'remote'."
    }
    if (-not $worktree) { throw 'the prepare answer carried no worktree path.' }
    $script:WorktreePath = $worktree
    Add-Result 'PREPARE_REMOTE' 'PASS' ("remote worktree {0} (branch {1}, base {2})" -f $worktree, $branch, (Get-Edge $baseSha 12))
}

# The prepared row must be readable as a REMOTE workspace through the Web route the
# product itself uses (nodes.rs:2539-2664). This is the same read path Pi's
# loom.workspace.read travels (managed-workflow-tool.ts:17-23 -> workspace_rpc.rs:485-518),
# so a wrong row here would make the Pi step meaningless.
function Test-MissionWorkspaceReady {
    if (-not $script:WorktreePath) {
        Add-Result 'REMOTE_WORKSPACE_READY' 'SKIP' 'no prepared remote worktree to inspect'
        return
    }
    $listing = Read-RemoteListing ''
    if ($null -eq $listing -or $listing.Error) {
        $reason = 'no answer'
        if ($listing) { $reason = $listing.Error }
        Add-Result 'REMOTE_WORKSPACE_READY' 'FAIL' ("listing the mission workspace root failed: {0}" -f $reason)
        return
    }
    $script:Evidence['remoteRoot'] = [ordered]@{
        relative  = ''
        ownerRole = $listing.OwnerRole
        ownerName = $listing.OwnerName
        entries   = $listing.Names
        truncated = $listing.Truncated
    }
    if ($listing.OwnerRole -ne 'remote') {
        Add-Result 'REMOTE_WORKSPACE_READY' 'FAIL' ("the resolved workspace row is '{0}', not 'remote' (nodes.rs:2666-2678)" -f $listing.OwnerRole)
        return
    }
    Add-Result 'REMOTE_WORKSPACE_READY' 'PASS' ("mission {0} has a ready remote workspace at {1}" -f $script:MissionId, $script:WorktreePath)
}

function Send-Instruction {
    $nonce = 'LOOM-CLOUD-' + (Get-Random -Minimum 100000 -Maximum 999999)
    $script:Nonce = $nonce
    # A single small real docx. Its bytes are the deterministic test input Pi has to move
    # through the real tool chain: loom.workspace.write -> loom.workspace.read ->
    # thread.message.send files. The deliverable name is fixed so the checks below can
    # read exactly that file back from the remote worktree.
    $script:PiRelative = 'acceptance.docx'
    $docxText = "$nonce cloud acceptance marker"
    $bytes = New-DocxBytes $docxText
    $extracted = Get-OoxmlText $bytes 'word/document.xml'
    if (-not $extracted -or $extracted -notlike "*$nonce*") {
        throw 'the generated docx does not carry its own marker.'
    }
    $script:MarkerBytes = $bytes
    $script:MarkerSha256 = Get-BytesSha256 $bytes
    $docxBase64 = [Convert]::ToBase64String($bytes)
    $script:Evidence['docx'] = [ordered]@{
        nonce         = $nonce
        deliverable   = $script:PiRelative
        byteSize      = $bytes.Length
        base64Length  = $docxBase64.Length
        sha256        = $script:MarkerSha256
        docxText      = $extracted
        entries       = @('[Content_Types].xml', '_rels/.rels', 'word/document.xml')
    }

    # The prompt names the real operation keys (managed-workflow-tool.ts:124-134) and the
    # teaching the tool itself publishes (:609-633): write the complete base64, read the
    # whole file back so the bridge materializes a localFile, then attach that path. The
    # base64 is test input, not an instruction to skip a tool: write/read/send are all
    # executed by Pi through rovai_loom inside Core.
    $instruction = 'Acceptance ' + $nonce + '. Do exactly these three steps with rovai_loom and nothing else.' +
        ' (1) loom.workspace.write with input {"path":"' + $script:PiRelative + '","data":"<BASE64_BELOW>"} - omit workspaceId so Core resolves my prepared Mission workspace, and paste the whole base64 unchanged as `data`.' +
        ' (2) loom.workspace.read with input {"path":"' + $script:PiRelative + '","offset":0,"maxBytes":1048576} and take the absolute localFile path it returns; never type a path yourself.' +
        ' (3) thread.message.send with input {"body":"acceptance ' + $nonce + ' delivery","files":["<THE localFile PATH FROM STEP 2>"]} so the docx is attached to this group.' +
        ' Then reply with one line: the localFile path you used. The docx bytes are exactly these, base64: ' + $docxBase64

    $content = [ordered]@{
        version  = 2
        segments = @(
            [ordered]@{ kind = 'atom'; atom = [ordered]@{ type = 'member'; agentId = $script:MemberId } },
            [ordered]@{ kind = 'text'; text = ' ' + $instruction }
        )
    }
    $sent = Invoke-CoreRequest 'thread.messages.send' ([ordered]@{
            commandId              = New-CommandId
            threadId               = $script:MissionThreadId
            content                = $content
            sourceAttachments      = @()
            quotes                 = @()
            replyToThreadMessageId = $null
            deliveryMode           = 'start'
            steerTargets           = @()
            execution              = [ordered]@{
                taskId         = $null
                purpose        = 'Cloud real acceptance: Pi writes the remote Mission workspace'
                completionRole = 'required'
            }
        }) $HttpTimeoutSeconds
    $commandResult = Get-Value $sent 'commandResult'
    $status = Get-Text $commandResult 'status'
    $messageId = Get-Text (Get-Value $commandResult 'payload') 'threadMessageId'
    if ($status -ne 'accepted' -or -not $messageId) {
        throw "thread.messages.send was not accepted: $status ($(Get-Text $commandResult 'code'))"
    }
    $script:SentMessageId = $messageId
    $script:Evidence['instruction'] = [ordered]@{
        threadId           = $script:MissionThreadId
        messageId          = $messageId
        nonce              = $nonce
        operations         = @('loom.workspace.write', 'loom.workspace.read', 'thread.message.send')
        deliverable        = $script:PiRelative
        expectedSha256     = $script:MarkerSha256
        instructionPreview = (Get-Edge $instruction 400)
    }
    Add-Result 'THREAD_SEND' 'PASS' ("instruction $nonce sent as message {0}: Pi is asked to write {1} through loom.workspace.write, read it back, and attach the materialized localFile" -f $messageId, $script:PiRelative)
}

function Get-CampSnapshot([string]$ThreadId) {
    return Invoke-CoreRequest 'camps.open' ([ordered]@{
            traceId  = New-CommandId
            threadId = $ThreadId
        }) $HttpTimeoutSeconds
}

# Pi's delivery is the point of this acceptance: an agent message carrying acceptance.docx.
# A settled Run without it, or a timeout, is a FAIL with the Run's own diagnosis - the
# product is expected to do this through rovai_loom (managed-workflow-tool.ts:59-77,609-633).
function Wait-AgentArtifact {
    $before = Get-CampSnapshot $script:MissionThreadId
    $seenRuns = New-Object 'Collections.Generic.HashSet[string]'
    foreach ($run in @(Get-Value $before 'agentRuns')) {
        if ($run) { [void]$seenRuns.Add((Get-Text $run 'id')) }
    }
    $terminal = @('succeeded', 'failed', 'cancelled')
    $wanted = $script:PiRelative
    $result = @{ Message = $null; Attachment = $null; Run = $null }
    $outcome = Wait-Until -TimeoutSeconds $RunTimeoutSeconds -IntervalMilliseconds $PollIntervalMilliseconds -Probe {
        try {
            $snapshot = Get-CampSnapshot $script:MissionThreadId
        } catch {
            # A long poll must survive a transient tunnel or Core hiccup. The last failure
            # is kept as evidence so a timeout is never a silent hole.
            $script:Evidence['agentPollLastError'] = Hide-Secrets $_.Exception.Message
            return $null
        }
        $run = $null
        foreach ($candidate in @(Get-Value $snapshot 'agentRuns')) {
            if (-not $candidate) { continue }
            if ($seenRuns.Contains((Get-Text $candidate 'id'))) { continue }
            $run = $candidate
        }
        foreach ($message in @(Get-Value $snapshot 'messages')) {
            if (-not $message) { continue }
            if ((Get-Text $message 'authorType') -ne 'agent') { continue }
            foreach ($attachment in @(Get-Value $message 'attachments')) {
                if (-not $attachment) { continue }
                $name = Get-Text $attachment 'displayName'
                if ($name -ne $wanted) { continue }
                $result.Run = $run
                $result.Message = $message
                $result.Attachment = $attachment
                return 'found'
            }
        }
        if ($run -and ($terminal -contains (Get-Text $run 'status'))) {
            $result.Run = $run
            return 'settled'
        }
        return $null
    }
    if ($outcome -eq 'found') {
        $script:Evidence['agentArtifact'] = [ordered]@{
            shownBy        = 'camps.open messages[].attachments (operations.rs:276, read_model.rs:843-863)'
            messageId      = Get-Text $result.Message 'id'
            attachmentId   = Get-Text $result.Attachment 'id'
            displayName    = Get-Text $result.Attachment 'displayName'
            byteSize       = Get-Value $result.Attachment 'byteSize'
            mediaType      = Get-Text $result.Attachment 'mediaType'
            agentRunId     = Get-Text $result.Run 'id'
            agentRunStatus = Get-Text $result.Run 'status'
        }
        Add-Result 'AGENT_ARTIFACT' 'PASS' ("agent message {0} carries attachment '{1}'" -f (Get-Text $result.Message 'id'), (Get-Text $result.Attachment 'displayName'))
        return 'found'
    }
    if ($outcome -eq 'settled') {
        $script:Evidence['agentRun'] = [ordered]@{
            id                 = Get-Text $result.Run 'id'
            status             = Get-Text $result.Run 'status'
            terminalReasonCode = Get-Text $result.Run 'terminalReasonCode'
            runtimeModel       = Get-Value $result.Run 'runtimeModel'
        }
        Add-Result 'AGENT_ARTIFACT' 'FAIL' ("the agent Run {0} settled as '{1}' without a '{2}' attachment (reason '{3}')" -f (Get-Text $result.Run 'id'), (Get-Text $result.Run 'status'), $wanted, (Get-Text $result.Run 'terminalReasonCode'))
        return 'settled'
    }
    Add-Result 'AGENT_ARTIFACT' 'FAIL' ("no agent message with a '{0}' attachment within {1}s" -f $wanted, $RunTimeoutSeconds)
    return 'timeout'
}

function Write-RemoteMarker {
    # The prepared worktree is a real directory on THIS machine (nodes.rs -> node
    # worktrees/<branch>, loom-node/src/session.rs:799-835). This probe is script-authored
    # and only proves the workspace transport; Pi's own deliverable is checked separately.
    $script:MarkerRelative = 'probe/marker-' + $script:Nonce + '.docx'
    $relativeNative = $script:MarkerRelative.Replace('/', '\')
    $target = Join-Path $script:WorktreePath $relativeNative
    try {
        [void](New-Directory ([IO.Path]::GetDirectoryName($target)))
        [IO.File]::WriteAllBytes($target, $script:MarkerBytes)
    } catch {
        Add-Result 'REMOTE_WORKSPACE_WRITE' 'FAIL' ("could not place the marker under the prepared worktree: {0}" -f $_.Exception.Message)
        return $false
    }
    $written = Get-FileSha256 $target
    if ($written -ne $script:MarkerSha256) {
        Add-Result 'REMOTE_WORKSPACE_WRITE' 'FAIL' 'the marker on disk does not hash to the generated bytes'
        return $false
    }
    $script:Evidence['remoteMarker'] = [ordered]@{
        authoredBy = 'acceptance-script (not Pi)'
        relative   = $script:MarkerRelative
        nativePath = $target
        byteSize   = $script:MarkerBytes.Length
        sha256     = $written
    }
    Add-Result 'REMOTE_WORKSPACE_WRITE' 'PASS' "marker written at $target (script-authored, hashes to the generated docx)"
    return $true
}

function Read-RemoteFile([string]$Relative) {
    # POST /api/v1/nodes/workspaces/files {missionId, relative, op:"read"} answers the
    # node's own base64 bytes (nodes.rs:2539-2664; MAX_READ_BYTES 1 MiB, workspace.rs:16).
    if (-not $Relative) { return $null }
    $body = [ordered]@{ missionId = $script:MissionId; relative = $Relative; op = 'read' }
    try {
        $reply = Invoke-JsonRoute -Method 'Post' -Path '/api/v1/nodes/workspaces/files' -Body $body -TimeoutSeconds $HttpTimeoutSeconds
    } catch {
        return @{ Error = (Hide-Secrets $_.Exception.Message) }
    }
    $data = Get-Text $reply 'data'
    if (-not $data) { return @{ Error = 'the read answered no data' } }
    $bytes = [Convert]::FromBase64String($data)
    return @{
        Error     = $null
        Bytes     = $bytes
        Sha256    = (Get-BytesSha256 $bytes)
        Size      = (Get-Value $reply 'size')
        Truncated = (Get-Value $reply 'truncated')
        OwnerName = Get-Text $reply 'ownerName'
    }
}

# One directory listing through the same route (nodes.rs:2539-2664). Never throws: the
# caller decides what a missing answer means.
function Read-RemoteListing([string]$Relative) {
    $body = [ordered]@{ missionId = $script:MissionId; relative = $Relative }
    try {
        $reply = Invoke-JsonRoute -Method 'Post' -Path '/api/v1/nodes/workspaces/files' -Body $body -TimeoutSeconds $HttpTimeoutSeconds
    } catch {
        return @{ Error = (Hide-Secrets $_.Exception.Message) }
    }
    $names = New-Object 'Collections.Generic.List[string]'
    foreach ($entry in @(Get-Value $reply 'entries')) {
        if ($entry) { [void]$names.Add((Get-Text $entry 'name')) }
    }
    return @{
        Error     = $null
        Relative  = $Relative
        OwnerRole = Get-Text $reply 'ownerRole'
        OwnerName = Get-Text $reply 'ownerName'
        Names     = $names.ToArray()
        Truncated = Get-Value $reply 'truncated'
    }
}

# Transport probe only: this marker is written by the script into the prepared worktree and
# read back through the node socket. It proves the workspace transport and is never counted
# as Pi evidence; the Pi-authored file is checked separately below.
function Test-RemoteRead {
    if (-not $script:WorktreePath) {
        Add-Result 'REMOTE_WORKSPACE_READ' 'SKIP' 'no prepared worktree to read'
        return
    }
    $probeDirectory = 'probe'
    $listing = Read-RemoteListing $probeDirectory
    if ($null -eq $listing -or $listing.Error) {
        $reason = 'no answer'
        if ($listing) { $reason = $listing.Error }
        Add-Result 'REMOTE_WORKSPACE_READ' 'FAIL' ("listing '{0}' failed: {1}" -f $probeDirectory, $reason)
        return
    }
    $script:Evidence['probeListing'] = [ordered]@{
        relative  = $probeDirectory
        ownerRole = $listing.OwnerRole
        ownerName = $listing.OwnerName
        entries   = $listing.Names
        truncated = $listing.Truncated
    }
    if ($listing.OwnerRole -ne 'remote') {
        Add-Result 'REMOTE_WORKSPACE_READ' 'FAIL' ("the resolved workspace row is '{0}', not 'remote' (nodes.rs:2666-2678)" -f $listing.OwnerRole)
        return
    }
    $read = Read-RemoteFile $script:MarkerRelative
    if ($null -eq $read -or $read.Error) {
        $reason = 'no answer'
        if ($read) { $reason = $read.Error }
        Add-Result 'REMOTE_WORKSPACE_READ' 'FAIL' ("reading $($script:MarkerRelative) failed: {0}" -f $reason)
        return
    }
    $script:Evidence['probeRead'] = [ordered]@{
        relative  = $script:MarkerRelative
        shownBy   = 'POST /api/v1/nodes/workspaces/files (lib.rs:318)'
        authoredBy = 'acceptance-script (transport probe, not Pi)'
        size      = $read.Size
        truncated = $read.Truncated
        sha256    = $read.Sha256
        matchesWrittenBytes = ($read.Sha256 -eq $script:MarkerSha256)
    }
    if ($read.Truncated -eq $true) {
        Add-Result 'REMOTE_WORKSPACE_READ' 'FAIL' 'the node truncated the read, so the bytes are not the whole file (workspace.rs:16,183-203)'
        return
    }
    if ($read.Sha256 -ne $script:MarkerSha256) {
        Add-Result 'REMOTE_WORKSPACE_READ' 'FAIL' ("bytes read back hash to {0}, written {1}" -f $read.Sha256, $script:MarkerSha256)
        return
    }
    Add-Result 'REMOTE_WORKSPACE_READ' 'PASS' ("transport probe: {0} round-tripped through the node with sha256 {1}" -f $script:MarkerRelative, $read.Sha256)
}

function Get-AttachmentBytes([string]$ThreadId, [string]$MessageId, [string]$AttachmentRefId) {
    # POST /api/v1/attachments with the exact owner locator (resources.rs:1088-1120,
    # local_attachment_source.rs:161-168); the answer is octet-stream bytes.
    return Invoke-BinaryPost -Path '/api/v1/attachments' -Body ([ordered]@{
            owner            = 'message'
            threadId         = $ThreadId
            messageId        = $MessageId
            attachmentRefId  = $AttachmentRefId
        }) -TimeoutSeconds (2 * $HttpTimeoutSeconds)
}

# The chain the acceptance exists for: the remote acceptance.docx that Pi wrote (read back
# through the Web node route) must be byte-identical to the group attachment (read back
# through the public attachment route), and both must be the bytes the instruction carried.
function Test-AttachmentChain([string]$ArtifactOutcome) {
    if ($ArtifactOutcome -ne 'found') {
        Add-Result 'REMOTE_FILE_READ' 'FAIL' 'no Pi-authored acceptance.docx message arrived, so there is nothing to read back'
        Add-Result 'ATTACHMENT_BYTES' 'FAIL' 'no Pi-authored acceptance.docx attachment arrived, so there is nothing to download'
        Add-Result 'SHA256_MATCH' 'FAIL' 'the remote file and the attachment could not be compared'
        return
    }
    $messageId = [string](Get-Value $script:Evidence['agentArtifact'] 'messageId')
    $attachmentId = [string](Get-Value $script:Evidence['agentArtifact'] 'attachmentId')
    if (-not $messageId -or -not $attachmentId) {
        Add-Result 'REMOTE_FILE_READ' 'FAIL' 'the agent message carried no attachment id'
        Add-Result 'ATTACHMENT_BYTES' 'FAIL' 'the agent message carried no attachment id'
        Add-Result 'SHA256_MATCH' 'FAIL' 'the remote file and the attachment could not be compared'
        return
    }

    # 1. The remote file, read through the route the Host uses to ask the node for bytes
    #    under the prepared worktree (nodes.rs:2539-2664).
    $read = Read-RemoteFile $script:PiRelative
    if ($null -eq $read -or $read.Error) {
        $reason = 'no answer'
        if ($read) { $reason = $read.Error }
        Add-Result 'REMOTE_FILE_READ' 'FAIL' ("reading the remote {0} failed: {1}" -f $script:PiRelative, $reason)
        $remoteSha = ''
    } elseif ($read.Truncated -eq $true) {
        Add-Result 'REMOTE_FILE_READ' 'FAIL' ("the node truncated {0}; a partial file cannot be compared (workspace.rs:16,183-203)" -f $script:PiRelative)
        $remoteSha = ''
    } else {
        $remoteSha = $read.Sha256
        $script:Evidence['remoteFile'] = [ordered]@{
            shownBy      = 'POST /api/v1/nodes/workspaces/files (lib.rs:318)'
            relative     = $script:PiRelative
            ownerName    = $read.OwnerName
            byteSize     = $read.Size
            truncated    = $read.Truncated
            sha256       = $remoteSha
            expectedSha256 = $script:MarkerSha256
        }
        if ($remoteSha -eq $script:MarkerSha256) {
            Add-Result 'REMOTE_FILE_READ' 'PASS' ("remote {0} holds exactly the instructed bytes (sha256 {1})" -f $script:PiRelative, $remoteSha)
        } else {
            Add-Result 'REMOTE_FILE_READ' 'FAIL' ("remote {0} hashes to {1}, the instruction carried {2}" -f $script:PiRelative, $remoteSha, $script:MarkerSha256)
        }
    }

    # 2. The group attachment, downloaded with the exact owner locator.
    try {
        $bytes = Get-AttachmentBytes $script:MissionThreadId $messageId $attachmentId
    } catch {
        Add-Result 'ATTACHMENT_BYTES' 'FAIL' ("downloading attachment {0} failed: {1}" -f $attachmentId, $_.Exception.Message)
        Add-Result 'SHA256_MATCH' 'FAIL' 'the attachment bytes are unavailable'
        return
    }
    $attachmentSha = Get-BytesSha256 $bytes
    $script:Evidence['attachmentBytes'] = [ordered]@{
        shownBy         = 'POST /api/v1/attachments (lib.rs:312)'
        threadId        = $script:MissionThreadId
        messageId       = $messageId
        attachmentRefId = $attachmentId
        byteSize        = $bytes.Length
        sha256          = $attachmentSha
        expectedSha256  = $script:MarkerSha256
    }
    Add-Result 'ATTACHMENT_BYTES' 'PASS' ("attachment {0} downloaded: {1} bytes, sha256 {2}" -f $attachmentId, $bytes.Length, $attachmentSha)

    # 3. Both byte streams against each other and against the instructed content.
    if (-not $remoteSha) {
        Add-Result 'SHA256_MATCH' 'FAIL' ('the remote file bytes are unavailable')
        return
    }
    $script:Evidence['sha256Comparison'] = [ordered]@{
        remoteRelative   = $script:PiRelative
        remoteFileSha256 = $remoteSha
        attachmentSha256 = $attachmentSha
        expectedSha256   = $script:MarkerSha256
        remoteEqualsAttachment = ($remoteSha -eq $attachmentSha)
        remoteEqualsExpected   = ($remoteSha -eq $script:MarkerSha256)
        attachmentEqualsExpected = ($attachmentSha -eq $script:MarkerSha256)
    }
    if ($remoteSha -eq $attachmentSha -and $remoteSha -eq $script:MarkerSha256) {
        Add-Result 'SHA256_MATCH' 'PASS' ("remote {0} and the group attachment are the same bytes the instruction carried ({1})" -f $script:PiRelative, $remoteSha)
    } else {
        Add-Result 'SHA256_MATCH' 'FAIL' ("remote {0} != attachment {1} (instruction carried {2})" -f $remoteSha, $attachmentSha, $script:MarkerSha256)
    }
}

function Stop-NodeAndVerifyOffline([string]$Label) {
    $stopId = 'NODE_STOP'
    $offlineId = 'NODE_OFFLINE'
    if ($Label) {
        $stopId = 'NODE_STOP_' + $Label
        $offlineId = 'NODE_OFFLINE_' + $Label
    }
    $stopped = Stop-OurNode
    $script:Evidence['nodeStop' + $Label] = [ordered]@{
        stoppedPids = @($script:NodePids)
        alivePids   = @($stopped.Alive)
    }
    if ($stopped.Alive.Count -gt 0) {
        Add-Result $stopId 'FAIL' ("node pid(s) {0} survived the stop" -f ($stopped.Alive -join ','))
        return $false
    }
    Add-Result $stopId 'PASS' ("stopped only this script's node pid(s) {0}" -f ($script:NodePids -join ','))
    $offline = Wait-Until -TimeoutSeconds $NodeOfflineTimeoutSeconds -IntervalMilliseconds $PollIntervalMilliseconds -Probe {
        $nodes = Try-NodeList
        $node = Find-RemoteNode $nodes $script:NodeId
        if ($node -and (Get-Text $node 'status') -eq 'offline') { return $node }
        return $null
    }
    if (-not $offline) {
        Add-Result $offlineId 'FAIL' ("node {0} still reports online after {1}s" -f $script:NodeId, $NodeOfflineTimeoutSeconds)
        return $false
    }
    $script:Evidence['nodeOffline' + $Label] = [ordered]@{
        nodeId        = $script:NodeId
        status        = Get-Text $offline 'status'
        lastHeartbeat = Get-Text $offline 'lastHeartbeat'
    }
    Add-Result $offlineId 'PASS' ("node {0} reports offline once its socket closed (device_presence.rs:52-61)" -f $script:NodeId)
    return $true
}

function Start-NodeAgain {
    $baseline = Get-NodeProcessIds
    $launcher = Start-NodeLauncher ''
    $script:Launcher = $launcher
    $online = Wait-Until -TimeoutSeconds $NodeOnlineTimeoutSeconds -IntervalMilliseconds $PollIntervalMilliseconds -Probe {
        [void](Add-NewNodePids $baseline)
        if ($launcher.HasExited) { return 'exited' }
        $nodes = Try-NodeList
        $node = Find-RemoteNode $nodes $script:NodeId
        if ($node -and (Get-Text $node 'status') -eq 'online') { return $node }
        return $null
    }
    [void](Add-NewNodePids $baseline)
    if ($online -eq 'exited') {
        Add-Result 'NODE_RECONNECT' 'FAIL' ("the reconnect launcher exited with code {0}" -f $launcher.ExitCode)
        return
    }
    if (-not $online) {
        Add-Result 'NODE_RECONNECT' 'FAIL' ("node {0} did not report online again within {1}s" -f $script:NodeId, $NodeOnlineTimeoutSeconds)
        return
    }
    $script:Evidence['nodeReconnect'] = [ordered]@{
        nodeId    = $script:NodeId
        status    = Get-Text $online 'status'
        pairedAt  = Get-Text $online 'pairedAt'
        credentialReused = $true
    }
    Add-Result 'NODE_RECONNECT' 'PASS' ("node {0} is online again using its stored credential (no second pairing code)" -f $script:NodeId)
}

function Test-ArtifactPreviewInterface {
    # loom.artifact.preview is the admitted artifact byte read (operations.rs:64-65,
    # loom.rs LoomArtifactPreviewInput). This run creates no LOOM plan/artifact, so only
    # the admission of the operation can be asserted, never a file comparison.
    $probe = Try-CoreRequest 'loom.artifact.preview' ([ordered]@{
            missionId  = $script:MissionId
            artifactId = 'cloud-acc-no-artifact'
        }) $HttpTimeoutSeconds
    if ($probe.Ok) {
        Add-Result 'ARTIFACT_PREVIEW' 'SKIP' 'loom.artifact.preview answered, but this mission registers no LOOM artifact to compare bytes with'
        return
    }
    $code = [string]$probe.Code
    if ($code -eq 'LOOM_EVIDENCE_NOT_FOUND' -or $code -eq 'loom_evidence_not_found') {
        Add-Result 'ARTIFACT_PREVIEW' 'SKIP' ("loom.artifact.preview is routed and admitted; Core rejected the placeholder artifact with {0}, and no LOOM artifact exists in this mission" -f $code)
    } else {
        Add-Result 'ARTIFACT_PREVIEW' 'SKIP' ("loom.artifact.preview answered '{0}'; no LOOM artifact exists in this mission to read bytes from" -f $probe.Message)
    }
}

# ======================================================================================
# artifacts
# ======================================================================================

function Write-AcceptanceArtifacts {
    $logRoot = $script:Paths['logs']
    $failed = @($script:Results | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0
    $overall = 'PASS'
    if ($failed) { $overall = 'FAIL' }
    $exitNumber = 0
    if ($failed) { $exitNumber = 1 }
    $summary = [ordered]@{
        kind          = 'loom-cloud-real-acceptance'
        schemaVersion = 1
        status        = $overall
        startedAt     = $script:StartedAt.ToString('o')
        finishedAt    = (Get-Date).ToString('o')
        durationMs    = [int](((Get-Date) - $script:StartedAt).TotalMilliseconds)
        target        = [ordered]@{
            cloudBaseUrl  = $script:BaseUrl
            connectUrl    = $script:ConnectUrl
            nodePackageDir = $NodePackageDir
            workRoot      = $script:Paths['work']
            nodeDataDir   = $script:NodeDataDir
            gitDir        = $script:GitDir
            octBaseUrl    = $OctBaseUrl
            modelId       = $ModelId
            nodeId        = $script:NodeId
            memberId      = $script:MemberId
            memberAdapterKind = $script:MemberAdapterKind
            threadId      = $script:ThreadId
            missionId     = $script:MissionId
            missionThreadId = $script:MissionThreadId
        }
        platform      = [ordered]@{
            psVersion = $PSVersionTable.PSVersion.ToString()
            os        = [Environment]::OSVersion.VersionString
            is64Bit   = [Environment]::Is64BitProcess
            machine   = $env:COMPUTERNAME
        }
        secrets       = [ordered]@{
            registered = $script:Secrets.Count
            note       = 'owner token, session Bearer, pairing code and OCT_API_KEY are registered for redaction and never written'
        }
        evidence      = $script:Evidence
        results       = $script:Results
    }
    $json = $summary | ConvertTo-Json -Depth 24
    $json = Hide-Secrets $json
    [IO.File]::WriteAllText((Join-Path $logRoot 'summary.json'), $json, $script:Utf8)

    $lines = New-Object 'Collections.Generic.List[string]'
    $lines.Add('LOOM cloud real acceptance (Bero Core + Win11 remote node)')
    $lines.Add('finished: ' + (Get-Date).ToString('o'))
    $lines.Add('origin:   ' + $script:BaseUrl)
    $lines.Add('node:     ' + $script:NodeId + '  member: ' + $script:MemberId)
    $lines.Add('mission:  ' + $script:MissionId + '  thread: ' + $script:MissionThreadId)
    $lines.Add('')
    foreach ($status in @('PASS', 'FAIL', 'SKIP')) {
        foreach ($entry in @($script:Results | Where-Object { $_.status -eq $status })) {
            $lines.Add(('{0,-5} {1,-24} {2,8} ms  {3}' -f $entry.status, $entry.id, $entry.durationMs, $entry.detail))
        }
    }
    $lines.Add('')
    $lines.Add('exit code: ' + $exitNumber)
    [IO.File]::WriteAllLines((Join-Path $logRoot 'report.txt'), $lines, $script:Utf8)
    return $failed
}

# ======================================================================================
# main
# ======================================================================================

$exitCode = 0
$artifactOutcome = 'none'
try {
    Assert-Timeout 'HttpTimeoutSeconds' $HttpTimeoutSeconds
    Assert-Timeout 'LoginTimeoutSeconds' $LoginTimeoutSeconds
    Assert-Timeout 'PairTimeoutSeconds' $PairTimeoutSeconds
    Assert-Timeout 'NodeOnlineTimeoutSeconds' $NodeOnlineTimeoutSeconds
    Assert-Timeout 'NodeOfflineTimeoutSeconds' $NodeOfflineTimeoutSeconds
    Assert-Timeout 'PrepareTimeoutSeconds' $PrepareTimeoutSeconds
    Assert-Timeout 'RunTimeoutSeconds' $RunTimeoutSeconds
    if ($PollIntervalMilliseconds -lt 100 -or $PollIntervalMilliseconds -gt 30000) {
        throw 'PollIntervalMilliseconds must be between 100 and 30000.'
    }

    Assert-Inputs
    Connect-Owner
    Read-AppInfo
    Set-PiProvider
    Select-Member

    # The pre-state is evidence, not control flow: a node that shows up online after this
    # snapshot is the one this run paired.
    $script:NodeIdsBefore = New-Object 'Collections.Generic.List[string]'
    foreach ($known in (Get-NodeList)) {
        if ($known -and (Get-Text $known 'role') -ne 'local') { [void]$script:NodeIdsBefore.Add((Get-Text $known 'nodeId')) }
    }
    $script:Evidence['nodesBeforePairing'] = $script:NodeIdsBefore.ToArray()

    Start-Node
    Wait-NodeOnline $script:NodeIdsBefore

    New-Thread
    $gitReady = Initialize-GitDirectory
    New-Mission
    if ($gitReady) {
        Invoke-PrepareRemote
    } else {
        Add-Result 'PREPARE_REMOTE' 'SKIP' 'no real git work tree to prepare, so no remote worktree is requested (workspace.rs:235-238)'
    }
    Test-MissionWorkspaceReady
    Send-Instruction
    # The transport probe (script-authored marker) runs while Pi works on its own artifact:
    # both are bounded and neither waits on the other. It is evidence of the workspace
    # transport only, never a substitute for the Pi-authored deliverable below.
    if ($script:WorktreePath) {
        $markerWritten = Write-RemoteMarker
        if ($markerWritten) {
            Test-RemoteRead
        } else {
            Add-Result 'REMOTE_WORKSPACE_READ' 'SKIP' 'the marker could not be written, so there is nothing to read back'
        }
    } else {
        Add-Result 'REMOTE_WORKSPACE_WRITE' 'SKIP' 'no prepared remote worktree on this machine'
        Add-Result 'REMOTE_WORKSPACE_READ' 'SKIP' 'no prepared remote worktree to read'
    }
    $artifactOutcome = Wait-AgentArtifact
    Test-AttachmentChain $artifactOutcome
    Test-ArtifactPreviewInterface

    [void](Stop-NodeAndVerifyOffline '')
    if (-not $SkipReconnect) {
        Start-NodeAgain
        [void](Stop-NodeAndVerifyOffline 'AFTER_RECONNECT')
    } else {
        Add-Result 'NODE_RECONNECT' 'SKIP' '-SkipReconnect was given'
    }
    Add-Result 'CLEANUP' 'PASS' ("node processes stopped; summary and report written under {0}" -f $script:Paths['logs'])
} catch {
    Add-Result 'ACCEPTANCE' 'FAIL' (Hide-Secrets $_.Exception.Message)
    $exitCode = 1
} finally {
    try {
        $alive = New-Object 'Collections.Generic.List[int]'
        if ($script:Launcher -and -not $script:Launcher.HasExited) { [void]$alive.Add($script:Launcher.Id) }
        foreach ($id in $script:NodePids) {
            if (Get-Process -Id $id -ErrorAction SilentlyContinue) { [void]$alive.Add($id) }
        }
        if ($alive.Count -gt 0) {
            $cleanup = Stop-OurNode
            if ($cleanup.Alive.Count -gt 0) {
                Add-Result 'CLEANUP_NODE' 'FAIL' ("node pid(s) {0} are still running" -f ($cleanup.Alive -join ','))
            } else {
                Add-Result 'CLEANUP_NODE' 'PASS' ("stopped this script's node pid(s) {0}" -f ($script:NodePids -join ','))
            }
        }
    } catch {
        Add-Result 'CLEANUP_NODE' 'FAIL' (Hide-Secrets $_.Exception.Message)
    }
    try {
        if (-not $KeepWorkRoot -and $script:GitDir -and [IO.Directory]::Exists($script:GitDir)) {
            try {
                Remove-Item -LiteralPath $script:GitDir -Recurse -Force -ErrorAction Stop
                Add-Result 'CLEANUP_FILES' 'PASS' "removed the temporary git repository $script:GitDir (the node data directory is kept)"
            } catch {
                Add-Result 'CLEANUP_FILES' 'SKIP' ("the temporary git repository stays at {0}: {1}" -f $script:GitDir, $_.Exception.Message)
            }
        } elseif ($KeepWorkRoot) {
            Add-Result 'CLEANUP_FILES' 'SKIP' ("-KeepWorkRoot keeps {0} and {1}" -f $script:GitDir, $script:NodeDataDir)
        }
    } catch {
        Add-Result 'CLEANUP_FILES' 'FAIL' (Hide-Secrets $_.Exception.Message)
    }
    try {
        $failed = Write-AcceptanceArtifacts
        if ($failed -and $exitCode -eq 0) { $exitCode = 1 }
    } catch {
        Write-Host ('log collection failed: ' + (Hide-Secrets $_.Exception.Message))
        if ($exitCode -eq 0) { $exitCode = 1 }
    }
    $script:SessionToken = $null
    $script:OwnerToken = $null
    $script:OctKey = $null
    $script:MarkerBytes = $null
}

$passed = @($script:Results | Where-Object { $_.status -eq 'PASS' }).Count
$skipped = @($script:Results | Where-Object { $_.status -eq 'SKIP' }).Count
$failed = @($script:Results | Where-Object { $_.status -eq 'FAIL' }).Count
Write-Host ''
Write-Host ('acceptance: {0} PASS / {1} SKIP / {2} FAIL; artifacts in {3}' -f $passed, $skipped, $failed, $script:Paths['logs'])
exit $exitCode
