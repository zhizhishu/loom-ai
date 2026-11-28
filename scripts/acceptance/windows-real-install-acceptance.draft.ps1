#requires -Version 5.1
<#
    DRAFT / NOT EXECUTED. Windows real-install acceptance for the LOOM personal package.
    Written for stock Windows PowerShell 5.1 only: Expand-Archive, Invoke-RestMethod,
    Invoke-WebRequest, Start-Process, Wait-Process, taskkill.exe and .NET Framework
    assemblies that ship with Windows. No third-party module, no network call except
    the loopback Host under test.

    Reference material read while writing this draft (read-only):
      scripts/manage-loom-personal.ps1
        :2-9       param block, Port default 64852 (this draft uses 18990)
        :273-295   Run-Loom: environment, "LOOM: http://127.0.0.1:<port>/",
                   `& rovai-server.exe --data-dir <data> --listen 127.0.0.1:<port>`
        :299-339   Install: absolute short paths, package/data/install separation
        :324       installation.json holds current commit, dataDirectory and port
        :361-371   stable Manage-Loom.ps1 / Start-Loom.cmd entry points
        :395-415   Start: reads state, re-verifies and runs the installed version
      scripts/lib/personal-install.test.mjs
        :458       start through Start-Loom.cmd (cmd.exe /d /c)
        :475-484   readiness = GET / returns 200 <html and the listener is the installed build
        :486-499   administrator token file <data>\server-token, POST /api/v1/login
                   {protocolVersion: 5, administratorToken}, POST /api/v1/request
                   {operation, params} with Bearer session token
        :299,350   stop the exact test-owned tree with taskkill.exe /T /F
      scripts/lib/create-configured-camp.mjs
        :51-70     ComposerDocument v2 explicit member addressing
      scripts/lib/minimax-live-qualification.mjs
        :94        threads.create {commandId,name,workspace,memberAgentIds,defaultLeadAgentId,collaborationMode}
        :104-105   thread.messages.send {commandId,threadId,content,sourceAttachments,quotes,
                   replyToThreadMessageId,deliveryMode,steerTargets,execution} ->
                   commandResult.status 'accepted', payload.threadMessageId
      scripts/lib/host-web.test.mjs
        :318-364   /api/v1/uploads multipart: intent {commandId,threadId,expectedRevision,
                   displayName,byteSize,sha256} + file part; response .draft is the
                   LocalAttachmentSourceRef usable as sourceAttachments[]
      scripts/smoke-skills.mjs
        :528-552   runtime.installations.list -> snapshot.models; members.runtime.set with
                   model {mode:'explicit',modelId,options}; members.get readback
      scripts/smoke-stop-continue.mjs:92-95
                   agentRuns.cancel {commandId, command:{threadId,agentRunId,expectedVersion}}
      scripts/probe-steer-version.mjs:100-104
                   the cancel version comes from camps.open agentRuns[].version
      scripts/lib/loom-v2-official-host-electron-review.test.mjs:286,439-440,468
                   loom.artifact.preview {missionId,artifactId} reads archived bytes;
                   host.web.stop / core.shutdown are the planned-stop evidence
      crates/rovai-core/src/read_model.rs:375-423
                   AgentRunView: id,status,version,inputMessageIds,runtimeModel
      crates/rovai-core/src/read_model.rs:305-318 + read_model/message_model.rs:11-15
                   ThreadMessageView.authorType/body/runtimeModel.modelId
      crates/rovai-core/src/local_attachment_source.rs:34-47
                   LocalAttachmentSourceRef (deny_unknown_fields); extractedText is the
                   admitted "browser-extracted Office document text" input channel
      crates/rovai-core/src/loom/pptx_preview.rs:44-61
                   office_command() asks bundled_office_command() FIRST and PATH second. The
                   Windows package ships runtime/office (LibreOffice + poppler), so the
                   preview never depends on a system soffice/pdftoppm install
      crates/rovai-core/src/loom/pptx_preview.rs:21-25,286-287
                   LoomArtifactPptxPreview {status, missingDependency, error, slides}; status
                   is "ready" only with one slide entry per presentation slide
      crates/rovai-core/src/loom.rs:1216-1219
                   LoomArtifactPreviewInput {missionId, artifactId}
      crates/rovai-core/src/loom.rs:1236-1245,3689-3696
                   LoomArtifactPreviewResult.pptxPreview; a .pptx preview reads the archived
                   bytes of a REGISTERED artifact and renders them on demand
      crates/rovai-web/src/operations.rs:39-43
                   registration, claims, task release and stage review stay OFF the network
                   capability: they belong to the agent side that owns the workspace
      crates/rovai-core/src/pi/managed-workflow-tool.ts:33-54
                   the agent side is rovai_loom -> the rovai CLI: loom.status, loom.plan,
                   loom.release, loom.claim, loom.evidence, loom.submit
      scripts/accept-loom-live-lead.mjs:1037-1052
                   missions.create {title,description,projectPath:'',
                   projectBindingKind:'quick_chat',memberAgentIds,defaultLeadAgentId,tags}
                   answers payload.missionId/payload.threadId
      scripts/accept-loom-live-lead.mjs:1055-1062
                   missions.start answers applied|accepted, never a claim that it already ran
      scripts/accept-live-device-workspace.mjs:152
                   the quick_chat local workspace is <data>\quick-chat
      scripts/lib/loom-pi-purge-production-ui.test.mjs:460-467
                   the goal template a real Pi run receives: rovai_loom status -> plan
                   (exactly one task) -> release -> claim -> evidence -> submit, then stop
      crates/rovai-web/src/operations.rs:58,270,342,376,386,392,419,615
                   Web boundary admits camps.open, runtime.installations.list,
                   thread.messages.send, agentRuns.cancel, threads.create,
                   members.runtime.set, loom.artifacts.list, loom.artifact.preview

    Two modes, one script, and the default is the real machine:
      * real machine (no switch): every hard rule below applies unchanged - the credential
        is read from $env:OCT_API_KEY, the oct-chat Pi catalog is written, the member model
        is frozen explicitly and every model-driven step is PASS/FAIL;
      * -InstallOnly (CI): EXTRACT, INSTALL, START, LOGIN, member, CAMP, PPTX_UPLOAD and STOP
        only. No credential is read, required or set, no scripted/loopback provider is
        started, no models.json/settings.json and no member model are written, the model
        rows are reported N/A, and STOP proves the real Web/API cancel control path on a
        model-free queued/nonterminal AgentRun.

    Hard rules encoded below:
      * in the default mode the model credential is read from $env:OCT_API_KEY only, fails
        fast when absent, and is never written to a log, command line, report or exception;
      * every path stays under a short work root (default C:\loomacc);
      * default port 18990, never 64851/64852;
      * the pptx preview is the REAL artifact preview: the agent registers the uploaded
        acceptance.pptx through rovai_loom, loom.artifact.preview must answer status
        "ready", and a preview that is not ready is a FAIL, never a SKIP;
      * -InstallOnly never claims a model result: the model lane belongs to the cloud VM
        real deepseek acceptance, so REAL_MODEL_IDENTITY, REAL_MODEL, DOCX_MARKER and
        PPTX_PREVIEW are N/A there and no model message, Mission or preview is created.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageZip,
    [int]$Port = 18990,
    [string]$WorkRoot = (Join-Path $env:SystemDrive 'loomacc'),
    [string]$ModelId = 'deepseek-v4.1-flash',
    [int]$ReadyTimeoutSeconds = 180,
    [int]$RunTimeoutSeconds = 420,
    [int]$StopTimeoutSeconds = 120,
    # CI install-only mode. Absent (the real-machine default) every step runs unchanged.
    [switch]$InstallOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Port -in @(64851, 64852)) { throw 'Port 64851/64852 belongs to the owner instances; choose 18990.' }

$script:Origin = "http://127.0.0.1:$Port"
$script:Results = New-Object 'Collections.Generic.List[object]'
$script:Secrets = New-Object 'Collections.Generic.List[string]'
$script:Utf8 = New-Object Text.UTF8Encoding($false)
$script:AdminToken = $null
$script:SessionToken = $null
$script:Evidence = [ordered]@{}
# Fallback log location only; Assert-ShortWorkRoot replaces it with <workRoot>\logs.
$script:Paths = [ordered]@{ logs = [IO.Path]::GetTempPath() }
$script:Launcher = $null
$script:InstallDirectory = $null
$script:DataDirectory = $null
$script:InstallOnly = [bool]$InstallOnly

# --------------------------------------------------------------------------------------
# reporting, redaction, tiny helpers
# --------------------------------------------------------------------------------------

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
    $entry = [pscustomobject]@{
        id = $Id
        status = $Status
        detail = Hide-Secrets $Detail
        at = (Get-Date).ToString('o')
    }
    [void]$script:Results.Add($entry)
    Write-Host ('[{0}] {1}: {2}' -f $entry.status, $entry.id, $entry.detail)
}

function Get-Value($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function New-CommandId { return [Guid]::NewGuid().ToString() }

function New-Directory([string]$Path) {
    if (-not [IO.Directory]::Exists($Path)) { [void][IO.Directory]::CreateDirectory($Path) }
    return $Path
}

function Wait-Until([scriptblock]$Probe, [int]$TimeoutSeconds, [int]$IntervalMilliseconds = 300) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $value = & $Probe
        if ($value) { return $value }
        Start-Sleep -Milliseconds $IntervalMilliseconds
    }
    return $null
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# --------------------------------------------------------------------------------------
# HTTP: loopback Host only
# --------------------------------------------------------------------------------------

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

function Invoke-JsonPost([string]$Url, $Body, [string]$Bearer, [int]$TimeoutSeconds = 120) {
    $headers = @{}
    if ($Bearer) { $headers['Authorization'] = "Bearer $Bearer" }
    $json = $Body | ConvertTo-Json -Depth 30 -Compress
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Post -UseBasicParsing -TimeoutSec $TimeoutSeconds `
            -ContentType 'application/json' -Headers $headers -Body $json
        return ($response.Content | ConvertFrom-Json)
    } catch {
        $status = 'transport'
        $errorBody = ''
        if ($_.Exception -is [System.Net.WebException] -and $_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            $errorBody = Read-ErrorBody $_.Exception
        }
        $detail = Hide-Secrets ('{0} -> HTTP {1} {2}' -f $Url, $status, $errorBody)
        throw $detail
    }
}

function Try-CoreRequest([string]$Operation, $Params, [int]$TimeoutSeconds = 120) {
    $body = [ordered]@{ operation = $Operation; params = $Params }
    try {
        $response = Invoke-JsonPost -Url ($script:Origin + '/api/v1/request') -Body $body `
            -Bearer $script:SessionToken -TimeoutSeconds $TimeoutSeconds
    } catch {
        return @{ Ok = $false; Status = 'transport'; Code = 'transport'; Message = (Hide-Secrets $_.Exception.Message); Result = $null }
    }
    $failure = Get-Value $response 'error'
    if ($failure) {
        return @{
            Ok = $false
            Status = 200
            Code = [string](Get-Value $failure 'code')
            Message = Hide-Secrets ([string](Get-Value $failure 'message'))
            Result = $null
        }
    }
    return @{ Ok = $true; Status = 200; Code = $null; Message = $null; Result = (Get-Value $response 'result') }
}

function Invoke-CoreRequest([string]$Operation, $Params, [int]$TimeoutSeconds = 120) {
    $reply = Try-CoreRequest $Operation $Params $TimeoutSeconds
    if (-not $reply.Ok) {
        throw ("operation {0} failed: status={1} code={2} message={3}" -f $Operation, $reply.Status, $reply.Code, $reply.Message)
    }
    return $reply.Result
}

function Invoke-Upload([string]$ThreadId, [string]$FilePath, [string]$DisplayName) {
    $bytes = [IO.File]::ReadAllBytes($FilePath)
    $intent = [ordered]@{
        commandId = New-CommandId
        threadId = $ThreadId
        expectedRevision = 1
        displayName = $DisplayName
        byteSize = $bytes.Length
        sha256 = (Get-FileSha256 $FilePath)
    }
    $boundary = '----loomacc' + [Guid]::NewGuid().ToString('N')
    $stream = New-Object IO.MemoryStream
    try {
        $write = {
            param([byte[]]$Chunk)
            $stream.Write($Chunk, 0, $Chunk.Length)
        }
        $intentPart = "--$boundary`r`nContent-Disposition: form-data; name=`"intent`"`r`n" +
            "Content-Type: application/json`r`n`r`n" + ($intent | ConvertTo-Json -Depth 8 -Compress) + "`r`n"
        & $write ($script:Utf8.GetBytes($intentPart))
        $filePart = "--$boundary`r`nContent-Disposition: form-data; name=`"file`"; filename=`"$DisplayName`"`r`n" +
            "Content-Type: application/octet-stream`r`n`r`n"
        & $write ($script:Utf8.GetBytes($filePart))
        & $write $bytes
        & $write ($script:Utf8.GetBytes("`r`n--$boundary--`r`n"))
        $payload = $stream.ToArray()
    } finally { $stream.Dispose() }
    try {
        $response = Invoke-WebRequest -Uri ($script:Origin + '/api/v1/uploads') -Method Post -UseBasicParsing `
            -TimeoutSec 180 -Headers @{ Authorization = "Bearer $script:SessionToken" } `
            -ContentType "multipart/form-data; boundary=$boundary" -Body $payload
    } catch {
        $status = 'transport'
        $errorBody = ''
        if ($_.Exception -is [System.Net.WebException] -and $_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            $errorBody = Read-ErrorBody $_.Exception
        }
        throw (Hide-Secrets ("upload {0} failed: HTTP {1} {2}" -f $DisplayName, $status, $errorBody))
    }
    $parsed = $response.Content | ConvertFrom-Json
    $draft = Get-Value $parsed 'draft'
    if (-not $draft) { throw "upload $DisplayName returned no draft" }
    return $draft
}

function New-SourceRef($Draft, [string]$ExtractedText) {
    # Only the fields admitted by LocalAttachmentSourceRef are forwarded
    # (crates/rovai-core/src/local_attachment_source.rs:34-47).
    $reference = [ordered]@{
        id = [string](Get-Value $Draft 'id')
        sourcePath = [string](Get-Value $Draft 'sourcePath')
        displayName = [string](Get-Value $Draft 'displayName')
        kind = [string](Get-Value $Draft 'kind')
        mediaType = Get-Value $Draft 'mediaType'
        observedByteSize = Get-Value $Draft 'observedByteSize'
    }
    if ($ExtractedText) { $reference['extractedText'] = $ExtractedText }
    return $reference
}

# --------------------------------------------------------------------------------------
# campaign helpers over the real Core
# --------------------------------------------------------------------------------------

function Get-CampSnapshot([string]$ThreadId) {
    return Invoke-CoreRequest 'camps.open' ([ordered]@{ traceId = New-CommandId; threadId = $ThreadId })
}

function New-Camp([string]$AgentId, [string]$Name) {
    $created = Invoke-CoreRequest 'threads.create' ([ordered]@{
            commandId = New-CommandId
            name = $Name
            workspace = $null
            memberAgentIds = @($AgentId)
            defaultLeadAgentId = $AgentId
            collaborationMode = 'peer'
        })
    $status = [string](Get-Value $created 'status')
    $threadId = Get-Value (Get-Value $created 'payload') 'threadId'
    if ($status -ne 'applied' -or -not $threadId) {
        throw "threads.create was not applied: $status"
    }
    return [string]$threadId
}

function Send-ThreadMessage([string]$ThreadId, [string]$AgentId, [string]$Text, $SourceRefs) {
    $content = [ordered]@{
        version = 2
        segments = @(
            [ordered]@{ kind = 'atom'; atom = [ordered]@{ type = 'member'; agentId = $AgentId } },
            [ordered]@{ kind = 'text'; text = " $Text" }
        )
    }
    $sent = Invoke-CoreRequest 'thread.messages.send' ([ordered]@{
            commandId = New-CommandId
            threadId = $ThreadId
            content = $content
            sourceAttachments = @($SourceRefs)
            quotes = @()
            replyToThreadMessageId = $null
            deliveryMode = 'start'
            steerTargets = @()
            execution = [ordered]@{
                taskId = $null
                purpose = 'Windows real-install acceptance'
                completionRole = 'required'
            }
        })
    $commandResult = Get-Value $sent 'commandResult'
    $status = [string](Get-Value $commandResult 'status')
    $messageId = Get-Value (Get-Value $commandResult 'payload') 'threadMessageId'
    if ($status -ne 'accepted' -or -not $messageId) {
        throw "thread.messages.send was not accepted: $status"
    }
    return [string]$messageId
}

function Get-NewRun($Snapshot, [string]$MessageId, $ExcludedIds) {
    $candidates = @()
    foreach ($run in @(Get-Value $Snapshot 'agentRuns')) {
        if (-not $run) { continue }
        $id = [string](Get-Value $run 'id')
        if ($ExcludedIds.Contains($id)) { continue }
        $candidates += $run
    }
    foreach ($run in $candidates) {
        if (@(Get-Value $run 'inputMessageIds') -contains $MessageId) { return $run }
    }
    if ($candidates.Count -gt 0) { return $candidates[$candidates.Count - 1] }
    return $null
}

function Wait-RunTerminal([string]$ThreadId, $Run) {
    $runId = [string](Get-Value $Run 'id')
    $terminal = @('succeeded', 'failed', 'cancelled')
    $settled = Wait-Until -TimeoutSeconds $RunTimeoutSeconds -Probe {
        $snapshot = Get-CampSnapshot $ThreadId
        foreach ($candidate in @(Get-Value $snapshot 'agentRuns')) {
            if ($candidate -and [string](Get-Value $candidate 'id') -eq $runId) {
                if ($terminal -contains [string](Get-Value $candidate 'status')) { return $candidate }
            }
        }
        return $null
    }
    return $settled
}

function Get-AgentReply($Snapshot, [string]$SinceMessageId) {
    $seen = $false
    $reply = $null
    foreach ($message in @(Get-Value $Snapshot 'messages')) {
        if (-not $message) { continue }
        $id = [string](Get-Value $message 'id')
        if (-not $seen -and $id -eq $SinceMessageId) { $seen = $true; continue }
        if (-not $seen) { continue }
        if ([string](Get-Value $message 'authorType') -eq 'agent') { $reply = $message }
    }
    return $reply
}

# --------------------------------------------------------------------------------------
# Office files: minimal OOXML written with the .NET Framework zip API
# --------------------------------------------------------------------------------------

function Write-TextFile([string]$Path, [string]$Content) {
    [void](New-Directory ([IO.Path]::GetDirectoryName($Path)))
    [IO.File]::WriteAllText($Path, $Content, $script:Utf8)
}

function New-OoxmlPackage([string]$Directory, [string]$TargetPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    if ([IO.File]::Exists($TargetPath)) { [IO.File]::Delete($TargetPath) }
    # CreateFromDirectory emits backslash entry names on .NET Framework/PS5.1, which
    # breaks OOXML part lookups (e.g. GetEntry('word/document.xml')). Write entries
    # manually so every name is a forward-slash relative path.
    $rootFull = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    $archive = [IO.Compression.ZipFile]::Open($TargetPath, 'Create')
    try {
        foreach ($file in [IO.Directory]::GetFiles($rootFull, '*', [IO.SearchOption]::AllDirectories)) {
            $relative = $file.Substring($rootFull.Length).TrimStart('\', '/')
            $entryName = $relative.Replace('\', '/')
            $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try {
                $source = [IO.File]::OpenRead($file)
                try { $source.CopyTo($entryStream) } finally { $source.Dispose() }
            } finally { $entryStream.Dispose() }
        }
    } finally { $archive.Dispose() }
    return $TargetPath
}

function New-DocxFile([string]$Path, [string]$Text) {
    $staging = Join-Path ([IO.Path]::GetDirectoryName($Path)) 'docx-src'
    if ([IO.Directory]::Exists($staging)) { [IO.Directory]::Delete($staging, $true) }
    Write-TextFile (Join-Path $staging '[Content_Types].xml') (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>')
    Write-TextFile (Join-Path $staging '_rels/.rels') (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>')
    $escaped = [System.Security.SecurityElement]::Escape($Text)
    Write-TextFile (Join-Path $staging 'word/document.xml') (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        "<w:p><w:r><w:t>$escaped</w:t></w:r></w:p><w:sectPr/></w:body></w:document>")
    return (New-OoxmlPackage $staging $Path)
}

function New-PptxFile([string]$Path, [string]$Text) {
    $staging = Join-Path ([IO.Path]::GetDirectoryName($Path)) 'pptx-src'
    if ([IO.Directory]::Exists($staging)) { [IO.Directory]::Delete($staging, $true) }
    Write-TextFile (Join-Path $staging '[Content_Types].xml') (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
        '</Types>')
    Write-TextFile (Join-Path $staging '_rels/.rels') (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
        '</Relationships>')
    Write-TextFile (Join-Path $staging 'ppt/presentation.xml') (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>' +
        '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>')
    Write-TextFile (Join-Path $staging 'ppt/_rels/presentation.xml.rels') (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
        '</Relationships>')
    $escaped = [System.Security.SecurityElement]::Escape($Text)
    Write-TextFile (Join-Path $staging 'ppt/slides/slide1.xml') (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
        "<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=`"en-US`"/><a:t>$escaped</a:t></a:r></a:p></p:txBody></p:sp>" +
        '</p:spTree></p:cSld></p:sld>')
    return (New-OoxmlPackage $staging $Path)
}

function Get-OoxmlText([string]$Path, [string]$EntryName) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entry = $zip.GetEntry($EntryName)
        if (-not $entry) { return $null }
        $reader = New-Object IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8)
        try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $zip.Dispose() }
    $text = [regex]::Replace($xml, '<[^>]+>', ' ')
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    return ([regex]::Replace($text, '\s+', ' ')).Trim()
}

function Get-PptxSlideCount([string]$Path) {
    # The uploaded page count: Core walks one <p:sldId> per slide in presentation order
    # (crates/rovai-core/src/loom/pptx_preview.rs:229-247), so the same element count in
    # ppt/presentation.xml is what pptxPreview.slides must report.
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entry = $zip.GetEntry('ppt/presentation.xml')
        if (-not $entry) { throw 'the generated pptx has no ppt/presentation.xml.' }
        $reader = New-Object IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8)
        try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $zip.Dispose() }
    # '<p:sldId ' needs the whitespace before its attributes: the bare '<p:sldId' prefix also
    # matches the '<p:sldIdLst>' container, which is not a slide.
    $count = [regex]::Matches($xml, '<p:sldId\s').Count
    if ($count -lt 1) { throw 'the generated pptx declares no slide.' }
    return $count
}

# --------------------------------------------------------------------------------------
# package, install, start, stop
# --------------------------------------------------------------------------------------

function Assert-ShortWorkRoot {
    if (-not [IO.Path]::IsPathRooted($WorkRoot)) { throw 'WorkRoot must be an absolute path.' }
    $root = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
    if ($root.Length -gt 40) { throw "WorkRoot must stay short for Expand-Archive: $($root.Length) characters" }
    if ($root -match '(^|\\)\.\.?(\\|$)') { throw 'WorkRoot must not contain . or .. segments.' }
    $script:Paths['work'] = New-Directory $root
    foreach ($name in @('pkg', 'logs', 'files')) {
        $script:Paths[$name] = New-Directory (Join-Path $root $name)
    }
    $script:Paths['inst'] = Join-Path $root 'inst'
    $script:Paths['data'] = Join-Path $root 'data'
    $script:InstallDirectory = $script:Paths['inst']
    $script:DataDirectory = $script:Paths['data']
}

function Expand-Package {
    if (-not (Test-Path -LiteralPath $PackageZip -PathType Leaf)) { throw "package zip not found: $PackageZip" }
    $copy = Join-Path $script:Paths['work'] 'pkg.zip'
    Copy-Item -LiteralPath $PackageZip -Destination $copy -Force
    $extracted = Join-Path $script:Paths['work'] 'unpacked'
    if ([IO.Directory]::Exists($extracted)) { [IO.Directory]::Delete($extracted, $true) }
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($copy, $extracted)
    $candidates = @(Get-ChildItem -LiteralPath $extracted -Filter 'candidate-manifest.json' -Recurse -Depth 2 -File -ErrorAction SilentlyContinue)
    if ($candidates.Count -eq 0) { throw 'candidate-manifest.json is missing: this is not a LOOM personal package.' }
    $root = $candidates[0].DirectoryName
    if (-not (Test-Path -LiteralPath (Join-Path $root 'Manage-Loom.ps1') -PathType Leaf)) {
        throw 'Manage-Loom.ps1 is missing from the extracted package.'
    }
    return $root
}

function Invoke-Manager([string[]]$Arguments, [string]$LogName) {
    $manager = Join-Path $packageRoot 'Manage-Loom.ps1'
    $out = Join-Path $script:Paths['logs'] ($LogName + '.out.txt')
    $err = Join-Path $script:Paths['logs'] ($LogName + '.err.txt')
    $process = Start-Process -FilePath 'powershell.exe' -PassThru -Wait -WindowStyle Hidden `
        -ArgumentList (@('-NoLogo', '-NoProfile', '-NonInteractive', '-File', ('"' + $manager + '"')) + $Arguments) `
        -RedirectStandardOutput $out -RedirectStandardError $err
    return @{ ExitCode = $process.ExitCode; StdOut = $out; StdErr = $err }
}

function Install-Package {
    $result = Invoke-Manager @(
        '-Action', 'Install',
        '-PackageDirectory', ('"' + $packageRoot + '"'),
        '-InstallDirectory', ('"' + $script:InstallDirectory + '"'),
        '-DataDirectory', ('"' + $script:DataDirectory + '"'),
        '-Port', [string]$Port
    ) 'install'
    if ($result.ExitCode -ne 0) {
        throw "Manage-Loom.ps1 -Action Install exited $($result.ExitCode); see logs\install.err.txt"
    }
    $statePath = Join-Path $script:InstallDirectory 'installation.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'installation.json was not written.' }
    $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
    $script:Evidence['installation'] = [ordered]@{
        current = Get-Value $state 'current'
        port = Get-Value $state 'port'
        dataDirectory = Get-Value $state 'dataDirectory'
        installDirectory = $script:InstallDirectory
    }
    if ([int](Get-Value $state 'port') -ne $Port) { throw 'installation.json recorded a different port.' }
}

function Start-LoomConsole {
    # Start-Loom.cmd is the product entry point (personal-install.test.mjs:458).
    $out = Join-Path $script:Paths['logs'] 'server.out.txt'
    $err = Join-Path $script:Paths['logs'] 'server.err.txt'
    $script:Launcher = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/c', 'Start-Loom.cmd' `
        -WorkingDirectory $script:InstallDirectory -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $out -RedirectStandardError $err
    return $script:Launcher
}

function Get-ListenerProcess {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $connection) { return $null }
    return (Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue)
}

function Wait-ServerReady {
    $ready = Wait-Until -TimeoutSeconds $ReadyTimeoutSeconds -IntervalMilliseconds 500 -Probe {
        if ($script:Launcher -and $script:Launcher.HasExited) { return $null }
        try {
            $probe = Invoke-WebRequest -Uri ($script:Origin + '/') -UseBasicParsing -TimeoutSec 5
            if ($probe.StatusCode -eq 200 -and $probe.Content -match '<html') { return $true }
        } catch { return $null }
        return $null
    }
    if (-not $ready) { throw "the installed Server did not become healthy within $ReadyTimeoutSeconds s" }
    $listener = Get-ListenerProcess
    if (-not $listener) { throw "no process listens on port $Port" }
    $installedRoot = [IO.Path]::GetFullPath($script:InstallDirectory).TrimEnd('\') + '\'
    $listenerPath = [string]$listener.Path
    if (-not $listenerPath.StartsWith($installedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "the listener on port $Port is not the installed version: $listenerPath"
    }
    $script:Evidence['listener'] = [ordered]@{ pid = $listener.Id; path = $listenerPath }
}

function Get-AdministratorToken {
    $tokenPath = Join-Path $script:DataDirectory 'server-token'
    $token = Wait-Until -TimeoutSeconds 60 -IntervalMilliseconds 200 -Probe {
        if (Test-Path -LiteralPath $tokenPath -PathType Leaf) {
            return ([IO.File]::ReadAllText($tokenPath)).Trim()
        }
        return $null
    }
    if (-not $token) { throw 'the Server did not persist server-token in the data directory.' }
    $script:AdminToken = $token
    Add-Secret $token
    return $token
}

function Connect-Administrator {
    $reply = Invoke-JsonPost -Url ($script:Origin + '/api/v1/login') -Bearer $null -Body ([ordered]@{
            protocolVersion = 5
            administratorToken = $script:AdminToken
        })
    $sessionToken = [string](Get-Value $reply 'token')
    if (-not $sessionToken) { throw 'administrator login returned no Bearer token.' }
    $script:SessionToken = $sessionToken
    Add-Secret $sessionToken
    $info = Invoke-CoreRequest 'app.info' ([ordered]@{})
    $script:Evidence['app'] = [ordered]@{ name = [string](Get-Value $info 'name') }
}

function Stop-LoomConsole {
    $launcher = $script:Launcher
    if ($launcher -and -not $launcher.HasExited) {
        # Same exact-tree stop as personal-install.test.mjs:299.
        & taskkill.exe /PID $launcher.Id /T /F | Out-Null
        try { Wait-Process -Id $launcher.Id -Timeout 30 -ErrorAction SilentlyContinue } catch { }
    }
    $listener = Get-ListenerProcess
    if ($listener) {
        Stop-Process -Id $listener.Id -Force -ErrorAction SilentlyContinue
        [void](Wait-Until -TimeoutSeconds 30 -IntervalMilliseconds 200 -Probe {
                if (-not (Get-ListenerProcess)) { return $true }
                return $null
            })
    }
    $gone = -not (Get-ListenerProcess)
    if ($gone) {
        Add-Result 'STOP_CONSOLE' 'PASS' "port $Port released after the console tree was stopped"
    } else {
        Add-Result 'STOP_CONSOLE' 'FAIL' "port $Port is still listening after the stop attempt"
    }
    return $gone
}

# --------------------------------------------------------------------------------------
# acceptance steps
# --------------------------------------------------------------------------------------

# --------------------------------------------------------------------------------------
# Pi-only member selection: the personal roster starts with a codex-cli assistant, which
# a personal Codex user does not have, and Claude Code is disabled for this acceptance.
# --------------------------------------------------------------------------------------

function ConvertTo-OrderedMap($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        $map = [ordered]@{}
        foreach ($key in @($Value.Keys)) { $map[[string]$key] = ConvertTo-OrderedMap ($Value[$key]) }
        return $map
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $map = [ordered]@{}
        foreach ($property in @($Value.PSObject.Properties)) {
            $map[$property.Name] = ConvertTo-OrderedMap ($property.Value)
        }
        return $map
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        $items = @()
        foreach ($item in $Value) { $items += , (ConvertTo-OrderedMap $item) }
        return $items
    }
    return $Value
}

function New-PiModelEntry {
    return [ordered]@{
        id = $ModelId
        name = $ModelId
        reasoning = $false
        input = @('text')
        contextWindow = 131072
        maxTokens = 16384
    }
}

function New-PiProviderEntry {
    return [ordered]@{
        name = 'oct-chat gateway'
        baseUrl = 'https://oct.agent-ai.vip/v1'
        # Environment reference only: Pi resolves $OCT_API_KEY from its own process
        # environment, so the literal key never lands in a file
        # (scripts/accept-loom-live-lead.mjs:578,598; scripts/loom-v2-core-native-pi.mjs:559).
        apiKey = '$OCT_API_KEY'
        api = 'openai-completions'
        models = @((New-PiModelEntry))
    }
}

function Set-PiOctChatGateway {
    # Pi reads its provider catalog from PI_CODING_AGENT_DIR. The personal install exports
    # that directory as <data>\runtime-home\pi before rovai-server.exe starts
    # (scripts/manage-loom-personal.ps1:276). Core keeps its own private Pi session root at
    # <data>\runtime\pi-windows-private-v1 (crates/rovai-core/src/pi/host.rs:3168-3179); that
    # root is not Pi's config root, so models.json belongs to the agent directory above.
    $key = $env:OCT_API_KEY
    if (-not $key -or $key.Trim().Length -eq 0) {
        throw 'FAIL_FAST: OCT_API_KEY is missing; the oct-chat provider key cannot be referenced.'
    }
    $key = $null
    if (-not $script:DataDirectory) { throw 'the personal data directory is unknown before Pi is configured.' }
    $agentDirectory = New-Directory (Join-Path $script:DataDirectory 'runtime-home\pi')

    $modelsPath = Join-Path $agentDirectory 'models.json'
    $document = [ordered]@{ providers = [ordered]@{} }
    if (Test-Path -LiteralPath $modelsPath -PathType Leaf) {
        $existingModels = [IO.File]::ReadAllText($modelsPath)
        if ($existingModels.Trim().Length -gt 0) {
            try { $document = ConvertTo-OrderedMap ($existingModels | ConvertFrom-Json) }
            catch { throw "models.json in the Pi agent directory is not valid JSON: $modelsPath" }
            if (-not ($document -is [System.Collections.IDictionary])) {
                throw "models.json in the Pi agent directory is not a JSON object: $modelsPath"
            }
        }
    }
    if (-not $document.Contains('providers') -or -not ($document['providers'] -is [System.Collections.IDictionary])) {
        $document['providers'] = [ordered]@{}
    }
    $written = $false
    $provider = $document['providers']['oct-chat']
    if (-not ($provider -is [System.Collections.IDictionary])) {
        $document['providers']['oct-chat'] = New-PiProviderEntry
        $provider = $document['providers']['oct-chat']
        $written = $true
    }
    $reference = [string]($provider['apiKey'])
    if (-not $reference) {
        $provider['apiKey'] = '$OCT_API_KEY'
        $written = $true
    }
    $offers = @()
    foreach ($entry in @($provider['models'])) {
        if ($entry -is [System.Collections.IDictionary]) { $offers += [string]($entry['id']) }
    }
    if ($offers -notcontains $ModelId) {
        $models = @()
        foreach ($entry in @($provider['models'])) { if ($null -ne $entry) { $models += , $entry } }
        $models += , (New-PiModelEntry)
        $provider['models'] = $models
        $written = $true
    }
    if ($written) {
        Write-TextFile $modelsPath (($document | ConvertTo-Json -Depth 12) + "`r`n")
    }

    # Pi needs one default provider/model to open its probe Session; existing user
    # defaults are kept byte-identical.
    $settingsPath = Join-Path $agentDirectory 'settings.json'
    $settings = [ordered]@{}
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        $existingSettings = [IO.File]::ReadAllText($settingsPath)
        if ($existingSettings.Trim().Length -gt 0) {
            try { $settings = ConvertTo-OrderedMap ($existingSettings | ConvertFrom-Json) }
            catch { throw "settings.json in the Pi agent directory is not valid JSON: $settingsPath" }
            if (-not ($settings -is [System.Collections.IDictionary])) {
                throw "settings.json in the Pi agent directory is not a JSON object: $settingsPath"
            }
        }
    }
    $settingsChanged = $false
    if (-not $settings.Contains('defaultProvider') -or -not $settings['defaultProvider']) {
        $settings['defaultProvider'] = 'oct-chat'
        $settingsChanged = $true
    }
    if (-not $settings.Contains('defaultModel') -or -not $settings['defaultModel']) {
        $settings['defaultModel'] = $ModelId
        $settingsChanged = $true
    }
    if ($settingsChanged) {
        Write-TextFile $settingsPath (($settings | ConvertTo-Json -Depth 12) + "`r`n")
    }

    $gateway = [ordered]@{
        agentDirectory = $agentDirectory
        modelsPath = $modelsPath
        settingsPath = $settingsPath
        provider = 'oct-chat'
        modelId = $ModelId
        apiKeyReference = 'OCT_API_KEY (value never recorded)'
        modelsRewritten = $written
        settingsRewritten = $settingsChanged
    }
    $script:Evidence['piGateway'] = $gateway
}

function Get-PiModelParts([string]$Value) {
    # Pi explicit identity: pi://model?provider=<provider>&id=<id>
    # (crates/rovai-core/src/pi/host.rs:2198-2205 builds it, :3149-3162 parses it).
    if ($Value -match '^pi://model\?(.+)$') {
        $provider = $null
        $identifier = $null
        foreach ($pair in ($matches[1] -split '&')) {
            $name, $raw = $pair -split '=', 2
            if (-not $raw) { continue }
            $decoded = [Uri]::UnescapeDataString($raw)
            if ($name -eq 'provider') { $provider = $decoded }
            if ($name -eq 'id') { $identifier = $decoded }
        }
        return @{ Provider = $provider; Id = $identifier }
    }
    return @{ Provider = $null; Id = $Value }
}

function Test-PiModelId([string]$Value) {
    if (-not $Value) { return $false }
    # PowerShell variable names and -eq are case-insensitive; compare the parsed id as one
    # trimmed scalar with -ceq so an array-valued part can never turn this into a mismatch.
    $actual = [string](@((Get-PiModelParts $Value).Id)[0])
    $expected = [string](@($ModelId)[0])
    return ($actual.Trim() -ceq $expected.Trim())
}

function Resolve-PiModelId($Installation) {
    # Prefer the identity the Pi snapshot actually reports; Pi models carry the provider
    # inside a pi:// id, with a provider field tolerated for a future snapshot shape.
    foreach ($model in @(Get-Value (Get-Value $Installation 'snapshot') 'models')) {
        if (-not $model) { continue }
        $id = [string](Get-Value $model 'id')
        if (-not $id) { continue }
        $provider = [string](Get-Value $model 'provider')
        $parts = Get-PiModelParts $id
        if (-not $provider) { $provider = $parts.Provider }
        if ($provider -eq 'oct-chat' -and $parts.Id -eq $ModelId) { return $id }
    }
    $encoded = [Uri]::EscapeDataString($ModelId)
    return "pi://model?provider=oct-chat&id=$encoded"
}

function Find-PiAssistantId {
    # Startup seeds the Pi 主助手 and binds it to Pi in the background task that runs after
    # runtime discovery, i.e. after the Host already answers requests
    # (crates/rovai-core/src/application.rs:21905-21913, :3717-3789). members.list only
    # reports already bound members (:3797-3808), so one read is a race: poll until the
    # binding lands, and only then fall back to creating a member.
    $found = Wait-Until -TimeoutSeconds 90 -IntervalMilliseconds 1500 -Probe {
        try { $members = @(Invoke-CoreRequest 'members.list' ([ordered]@{})) }
        catch { $members = @() }
        foreach ($member in $members) {
            if (-not $member) { continue }
            $configuration = Get-Value $member 'runtimeConfiguration'
            if ([string](Get-Value $configuration 'adapterKind') -ne 'pi') { continue }
            return [string](Get-Value $member 'agentId')
        }
        return $null
    }
    return $found
}

function New-PiAssistant {
    # The personal onboarding/assistant editor creates a profile with members.create and the
    # plain CreateAgentProfileCommand shape, then configures the runtime separately
    # (apps/desktop/src/renderer/src/loom-native/assistant-service.ts:526-562;
    # apps/desktop/src/renderer/src/onboarding-provisioning.ts:132-142;
    # crates/rovai-core/src/agent_profile.rs:978-990, :2835-2941).
    $created = Invoke-CoreRequest 'members.create' ([ordered]@{
            commandId = (New-CommandId)
            command = [ordered]@{
                displayName = 'LOOM Windows acceptance Pi assistant'
                avatarRef = $null
                teamRole = 'Windows real-install acceptance runner'
                professionalResponsibilities = 'Run the real-install acceptance conversation on the oct-chat Pi model only.'
                personalityTraits = @('precise', 'concise')
                workingPrinciples = 'Answer only what is asked and never claim unverified results.'
                growthTopic = ''
            }
        })
    $status = [string](Get-Value $created 'status')
    $agentId = [string](Get-Value (Get-Value $created 'payload') 'agentId')
    if ($status -ne 'applied' -or -not $agentId) {
        throw "members.create for the Pi assistant was not applied: $status"
    }
    return $agentId
}

function Find-RuntimeInstallation([string]$AdapterKind, [switch]$ReadyOnly) {
    foreach ($item in @(Invoke-CoreRequest 'runtime.installations.list' ([ordered]@{}))) {
        if ([string](Get-Value $item 'adapterKind') -ne $AdapterKind) { continue }
        if ($ReadyOnly -and [string](Get-Value (Get-Value $item 'snapshot') 'probeStatus') -ne 'ready') { continue }
        return $item
    }
    return $null
}

function Select-MemberAndModel {
    # Fail fast on the credential and write the oct-chat provider catalog before any Pi
    # probe runs, so the runtime snapshot can report the model this acceptance needs. The
    # catalog is written after start: <data> only exists once the Host created it with its
    # protected DACL.
    [void](Set-PiOctChatGateway)
    $agentId = Find-PiAssistantId
    if (-not $agentId) {
        $agentId = New-PiAssistant
        Add-Result 'MEMBER_CREATE' 'PASS' "members.create created the Pi assistant $agentId"
    }
    $adapterKind = 'pi'

    # Freeze the member runtime BEFORE waiting for a probe. The startup binding and every
    # members.runtime.set are configuration changes, and a runtime check that finishes
    # afterwards is reported as Superseded: it publishes no ready installation snapshot
    # (crates/rovai-core/src/application.rs:2324-2342, :28570-28582). A wait that starts
    # before the set therefore never observes ready. The explicit model also replaces the
    # startup binding's runtime_default, so the conversation runs on oct-chat.
    $installation = Find-RuntimeInstallation $adapterKind
    if (-not $installation) {
        throw "runtime $adapterKind is not installed; the member runtime cannot be configured."
    }
    $permissions = Get-Value (Get-Value $installation 'memberRuntimeDefaults') 'permissions'
    if (-not $permissions) {
        throw "runtime $adapterKind reports no member runtime defaults; its permissions are unknown."
    }
    # Pi reports memberRuntimeDefaults.permissions.values as an empty object, so a verbatim
    # freeze would leave loom_file_access unset, every Run would fall back to Native
    # execution (rovai_loom is not provided there) and PPTX_PREVIEW could not succeed.
    # Force the workspace_workflow grant on a private copy and keep schemaVersion,
    # adapterKind and every other reported value
    # (scripts/acceptance/cloud-workspace-chain.mjs:162-164). values is read before the
    # conversion: on a dictionary the key 'values' is ambiguous with .Values.
    $permissionValues = ConvertTo-OrderedMap (Get-Value $permissions 'values')
    if ($null -eq $permissionValues) {
        $permissionValues = [ordered]@{}
    } elseif ($permissionValues -isnot [System.Collections.IDictionary]) {
        throw "runtime $adapterKind reports permissions.values that are not an object."
    }
    $permissionValues['loom_file_access'] = 'workspace_workflow'
    $permissions = ConvertTo-OrderedMap $permissions
    if ($permissions -isnot [System.Collections.IDictionary]) {
        throw "runtime $adapterKind reports permissions that are not an object."
    }
    $permissions['values'] = $permissionValues
    # Not $modelId: PowerShell variable names are case-insensitive, so that name would
    # overwrite the script-level $ModelId parameter and Test-PiModelId would compare the
    # bare model id against the full pi:// identity.
    $piExplicitModelId = Resolve-PiModelId $installation

    $profile = $null
    $configured = $null
    foreach ($attempt in 1..3) {
        $profile = Invoke-CoreRequest 'members.get' ([ordered]@{ agentId = $agentId })
        $configured = Invoke-CoreRequest 'members.runtime.set' ([ordered]@{
                commandId = (New-CommandId)
                command = [ordered]@{
                    agentId = $agentId
                    expectedVersion = (Get-Value $profile 'version')
                    adapterKind = $adapterKind
                    model = [ordered]@{ mode = 'explicit'; modelId = $piExplicitModelId; options = [ordered]@{} }
                    permissions = $permissions
                }
            })
        if ([string](Get-Value $configured 'status') -eq 'applied') { break }
        $code = [string](Get-Value $configured 'code')
        if ($code -ne 'version_conflict' -or $attempt -eq 3) {
            throw "members.runtime.set for $piExplicitModelId was not applied: $code"
        }
        # A concurrent writer bumped the profile version; re-read and retry.
        Start-Sleep -Milliseconds 500
    }

    # runtime.product.check blocks until this round's probe finishes
    # (crates/rovai-core/src/application.rs:4821-4868), but its reply is not evidence: a
    # superseded or deferred attempt completes the operation without publishing a ready
    # snapshot, so only runtime.installations.list decides and every round is retried.
    $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
    $probeFailure = $null
    $installation = Find-RuntimeInstallation $adapterKind -ReadyOnly
    while (-not $installation -and (Get-Date) -lt $deadline) {
        try {
            [void](Invoke-CoreRequest 'runtime.product.check' ([ordered]@{ runtimeKind = $adapterKind }))
            $probeFailure = $null
        } catch {
            $probeFailure = $_.Exception.Message
        }
        $installation = Find-RuntimeInstallation $adapterKind -ReadyOnly
        if ($installation) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $installation) {
        $detail = if ($probeFailure) { ": $probeFailure" } else { '.' }
        throw "runtime $adapterKind did not become ready $ReadyTimeoutSeconds s after members.runtime.set$detail"
    }

    $profile = Invoke-CoreRequest 'members.get' ([ordered]@{ agentId = $agentId })
    $runtimeConfiguration = Get-Value $profile 'runtimeConfiguration'
    $resolvedModel = [string](Get-Value (Get-Value $runtimeConfiguration 'model') 'modelId')
    $readiness = [string](Get-Value (Get-Value $profile 'runtimeReadiness') 'status')
    if ([string](Get-Value $runtimeConfiguration 'adapterKind') -ne $adapterKind) {
        throw "the member runtime adapter is not $adapterKind after members.runtime.set."
    }
    if (-not (Test-PiModelId $resolvedModel)) { throw "the member frozen model is $resolvedModel, not $ModelId." }
    # A configured member profile stops at installed_unverified
    # (crates/rovai-core/src/agent_profile.rs:5650-5701); ready, light_ready and
    # installed_unverified are the launch-eligible states
    # (crates/rovai-core/src/member_execution_availability.rs:38-46). The ready Pi snapshot
    # above is the proof that the runtime itself is verified.
    if (@('ready', 'light_ready', 'installed_unverified') -notcontains $readiness) {
        throw "member runtime readiness is $readiness, not launch-eligible."
    }
    $script:Evidence['member'] = [ordered]@{
        agentId = $agentId
        adapterKind = $adapterKind
        modelId = $resolvedModel
        readiness = $readiness
        installationId = [string](Get-Value $installation 'id')
        probeStatus = [string](Get-Value (Get-Value $installation 'snapshot') 'probeStatus')
    }
    Add-Result 'MEMBER_MODEL' 'PASS' "$agentId uses $adapterKind / $resolvedModel"
    return $agentId
}

function Invoke-RealModelTurn([string]$ThreadId, [string]$AgentId) {
    $nonce = 'LOOM-REPLY-' + (Get-Random -Minimum 100000 -Maximum 999999)
    $before = Get-CampSnapshot $ThreadId
    $excluded = New-Object 'Collections.Generic.HashSet[string]'
    foreach ($run in @(Get-Value $before 'agentRuns')) { if ($run) { [void]$excluded.Add([string](Get-Value $run 'id')) } }
    $messageId = Send-ThreadMessage $ThreadId $AgentId `
        "Real-model smoke: reply with exactly the token $nonce and nothing else. Do not use tools." @()
    $run = Wait-Until -TimeoutSeconds 60 -IntervalMilliseconds 200 -Probe {
        $snapshot = Get-CampSnapshot $ThreadId
        return (Get-NewRun $snapshot $messageId $excluded)
    }
    if (-not $run) { throw 'no AgentRun was created for the real-model message.' }
    $run = Wait-RunTerminal $ThreadId $run
    if (-not $run) { throw "the real-model AgentRun did not reach a terminal state within $RunTimeoutSeconds s." }
    $status = [string](Get-Value $run 'status')
    if ($status -ne 'succeeded') {
        throw ("the real-model AgentRun ended {0} (reason {1})." -f $status, [string](Get-Value $run 'terminalReasonCode'))
    }
    $snapshot = Get-CampSnapshot $ThreadId
    $reply = Get-AgentReply $snapshot $messageId
    $body = ''
    if ($reply) { $body = [string](Get-Value $reply 'body') }
    if ($body -notlike "*$nonce*") { throw 'the assistant reply did not contain the request token.' }
    $observedModel = Get-Value $run 'runtimeModel'
    if (-not $observedModel) { $observedModel = Get-Value $reply 'runtimeModel' }
    $observedModelId = [string](Get-Value $observedModel 'modelId')
    # The Run reports the explicit pi:// identity (crates/rovai-core/src/pi/host.rs:2198-2205),
    # so compare through Test-PiModelId instead of the bare id.
    if ($observedModelId -and -not (Test-PiModelId $observedModelId)) {
        throw "the run reported model $observedModelId, not $ModelId."
    }
    if (-not $observedModelId) {
        Add-Result 'REAL_MODEL_IDENTITY' 'SKIP' 'the Run and the reply reported no runtimeModel.modelId'
    } else {
        Add-Result 'REAL_MODEL_IDENTITY' 'PASS' "run reported $observedModelId"
    }
    $script:Evidence['realModel'] = [ordered]@{
        threadId = $ThreadId
        messageId = $messageId
        agentRunId = [string](Get-Value $run 'id')
        runStatus = $status
        observedModelId = $observedModelId
        replyPreview = $body.Substring(0, [Math]::Min(200, $body.Length))
    }
    Add-Result 'REAL_MODEL' 'PASS' "real reply received for $nonce"
}

function Invoke-DocxCheck([string]$ThreadId, [string]$AgentId) {
    $marker = 'LOOM-DOCX-MARKER-' + (Get-Random -Minimum 100000 -Maximum 999999)
    $path = Join-Path $script:Paths['files'] 'acceptance.docx'
    [void](New-DocxFile $path ("$marker first acceptance paragraph."))
    $extracted = Get-OoxmlText $path 'word/document.xml'
    if ($extracted -notlike "*$marker*") { throw 'the generated docx does not contain its own marker.' }
    $draft = Invoke-Upload $ThreadId $path 'acceptance.docx'
    $source = New-SourceRef $draft $extracted
    $before = Get-CampSnapshot $ThreadId
    $excluded = New-Object 'Collections.Generic.HashSet[string]'
    foreach ($run in @(Get-Value $before 'agentRuns')) { if ($run) { [void]$excluded.Add([string](Get-Value $run 'id')) } }
    $messageId = Send-ThreadMessage $ThreadId $AgentId `
        "Read the attached acceptance.docx text and reply with the single line that starts with LOOM-DOCX-MARKER. Never guess." @($source)
    $run = Wait-Until -TimeoutSeconds 60 -IntervalMilliseconds 200 -Probe {
        $snapshot = Get-CampSnapshot $ThreadId
        return (Get-NewRun $snapshot $messageId $excluded)
    }
    if (-not $run) { throw 'no AgentRun was created for the docx message.' }
    $run = Wait-RunTerminal $ThreadId $run
    if (-not $run) { throw "the docx AgentRun did not reach a terminal state within $RunTimeoutSeconds s." }
    if ([string](Get-Value $run 'status') -ne 'succeeded') {
        throw ("the docx AgentRun ended {0} (reason {1})." -f [string](Get-Value $run 'status'), [string](Get-Value $run 'terminalReasonCode'))
    }
    $reply = Get-AgentReply (Get-CampSnapshot $ThreadId) $messageId
    $body = ''
    if ($reply) { $body = [string](Get-Value $reply 'body') }
    if ($body -notlike "*$marker*") { throw 'the assistant reply did not quote the docx marker.' }
    $script:Evidence['docx'] = [ordered]@{
        marker = $marker
        sourcePath = [string](Get-Value $source 'sourcePath')
        attachmentId = [string](Get-Value $source 'id')
        agentRunId = [string](Get-Value $run 'id')
        replyPreview = $body.Substring(0, [Math]::Min(200, $body.Length))
    }
    Add-Result 'DOCX_MARKER' 'PASS' "assistant quoted $marker from the uploaded docx"
}

function Test-PptxPreviewInterface([string]$ThreadId, [string]$AgentId) {
    $marker = 'LOOM-PPTX-MARKER-' + (Get-Random -Minimum 100000 -Maximum 999999)
    $path = Join-Path $script:Paths['files'] 'acceptance.pptx'
    [void](New-PptxFile $path ("$marker slide one."))
    $expectedSlides = Get-PptxSlideCount $path
    $draft = Invoke-Upload $ThreadId $path 'acceptance.pptx'
    $sourcePath = [string](Get-Value $draft 'sourcePath')
    if (-not $sourcePath) { throw 'the pptx upload returned no source path.' }
    Add-Result 'PPTX_UPLOAD' 'PASS' "uploaded acceptance.pptx as $([string](Get-Value $draft 'id')) with $expectedSlides slide(s)"

    # The quick_chat Mission workspace is <data>\quick-chat
    # (scripts/accept-live-device-workspace.mjs:152), so the already uploaded file is copied
    # there BEFORE the Mission starts and the agent registers that exact file.
    $workspacePptx = Join-Path (New-Directory (Join-Path $script:DataDirectory 'quick-chat')) 'acceptance.pptx'
    Copy-Item -LiteralPath $path -Destination $workspacePptx -Force
    if (-not [IO.File]::Exists($workspacePptx)) { throw 'acceptance.pptx was not copied into the Mission workspace.' }

    # Registration, claims and task release are not Web capabilities
    # (crates/rovai-web/src/operations.rs:39-43): the bundled agent reaches them through
    # rovai_loom -> the rovai CLI (crates/rovai-core/src/pi/managed-workflow-tool.ts:33-54),
    # so the Mission goal is the chain from scripts/lib/loom-pi-purge-production-ui.test.mjs:460-467
    # with "write the file" replaced by "register the file already in the workspace".
    $goal = @(
        'Windows real-install acceptance: register the pptx already in the workspace and submit the candidate, do not rewrite the file.'
        "You are the Default Lead and the only executor; member ID is $AgentId."
        'acceptance.pptx is already in this Mission workspace; do not rewrite, regenerate or rename it.'
        "Use rovai_loom in order: loom.status -> loom.plan (exactly 1 task, assigneeAgentId set to $AgentId) -> loom.release -> loom.claim."
        "Then use loom.evidence with relativePath='acceptance.pptx' to register that file and bind it to that task, and loom.submit to submit the returned artifactId."
        'Then stop: the candidate stays pending; do not review, do not accept, do not use bash/shell/MCP, and write no other files.'
    ) -join "`r`n"

    $created = Invoke-CoreRequest 'missions.create' ([ordered]@{
            commandId = New-CommandId
            command = [ordered]@{
                title = "LOOM Windows acceptance pptx preview $((Get-Date).ToString('yyyyMMdd-HHmmss'))"
                description = $goal
                projectPath = ''
                projectBindingKind = 'quick_chat'
                memberAgentIds = @($AgentId)
                defaultLeadAgentId = $AgentId
                tags = @('windows-acceptance', 'pptx-preview')
            }
        })
    $createdStatus = [string](Get-Value $created 'status')
    $missionId = [string](Get-Value (Get-Value $created 'payload') 'missionId')
    $missionThreadId = [string](Get-Value (Get-Value $created 'payload') 'threadId')
    if ($createdStatus -cne 'applied' -or -not $missionId -or -not $missionThreadId) {
        throw ("missions.create was not applied: {0}" -f $createdStatus)
    }

    $started = Invoke-CoreRequest 'missions.start' ([ordered]@{
            commandId = New-CommandId
            command = [ordered]@{ missionId = $missionId }
        })
    $startedStatus = [string](Get-Value $started 'status')
    if (@('applied', 'accepted') -notcontains $startedStatus) {
        throw ("missions.start was not accepted for {0}: {1}" -f $missionId, $startedStatus)
    }

    # Poll the artifacts of THIS Mission until the agent has registered acceptance.pptx. No
    # placeholder artifact is ever previewed: only the row Core lists for this Mission counts.
    $deadline = (Get-Date).AddSeconds($RunTimeoutSeconds)
    $artifact = $null
    $runNote = 'no AgentRun reported yet'
    while (-not $artifact -and (Get-Date) -lt $deadline) {
        $listed = Try-CoreRequest 'loom.artifacts.list' ([ordered]@{ missionId = $missionId })
        if ($listed.Ok) {
            $rows = @()
            $nested = Get-Value $listed.Result 'artifacts'
            if ($nested) { $rows = @($nested) }
            elseif ($listed.Result -is [System.Collections.IEnumerable] -and $listed.Result -isnot [string]) { $rows = @($listed.Result) }
            foreach ($row in $rows) {
                if (-not $row) { continue }
                if ([string](Get-Value $row 'relativePath').Trim() -ceq 'acceptance.pptx') { $artifact = $row; break }
            }
        }
        if ($artifact) { break }
        try { $snapshot = Get-CampSnapshot $missionThreadId } catch { $snapshot = $null }
        foreach ($run in @(Get-Value $snapshot 'agentRuns')) {
            if (-not $run) { continue }
            $runStatus = [string](Get-Value $run 'status')
            $runNote = "agentRun $([string](Get-Value $run 'id')) is $runStatus"
            if ($runStatus -ceq 'failed' -or $runStatus -ceq 'cancelled') {
                throw ("the Mission Run {0} ended {1} (reason {2}) without registering acceptance.pptx" -f `
                        [string](Get-Value $run 'id'), $runStatus, [string](Get-Value $run 'terminalReasonCode'))
            }
        }
        Start-Sleep -Seconds 2
    }
    if (-not $artifact) { throw ("no acceptance.pptx artifact was registered within {0} s ({1})." -f $RunTimeoutSeconds, $runNote) }
    $artifactId = [string](Get-Value $artifact 'artifactId')
    if (-not $artifactId) { throw 'loom.artifacts.list reported acceptance.pptx without an artifactId.' }

    # loom.artifact.preview renders the ARCHIVED bytes on demand
    # (crates/rovai-core/src/loom.rs:1236-1245, 3689-3696).
    $preview = Invoke-CoreRequest 'loom.artifact.preview' ([ordered]@{ missionId = $missionId; artifactId = $artifactId })
    $pptxPreview = Get-Value $preview 'pptxPreview'
    if (-not $pptxPreview) { throw "loom.artifact.preview returned no pptxPreview for $artifactId." }
    $previewStatus = [string](Get-Value $pptxPreview 'status')
    $previewSlides = @()
    foreach ($slide in @(Get-Value $pptxPreview 'slides')) { if ($null -ne $slide) { $previewSlides += $slide } }
    if ($previewStatus -cne 'ready') {
        throw ("pptxPreview.status is {0} (missingDependency={1} error={2})." -f $previewStatus, `
                [string](Get-Value $pptxPreview 'missingDependency'), [string](Get-Value $pptxPreview 'error'))
    }
    if ($previewSlides.Count -ne $expectedSlides) {
        throw ("pptxPreview.slides.Count is {0} but the uploaded acceptance.pptx declares {1} slide(s)." -f `
                $previewSlides.Count, $expectedSlides)
    }

    $script:Evidence['pptx'] = [ordered]@{
        attachmentId = [string](Get-Value $draft 'id')
        sourcePath = $sourcePath
        missionId = $missionId
        artifactId = $artifactId
        sha256 = (Get-FileSha256 $path)
        expectedSlides = $expectedSlides
        previewStatus = $previewStatus
        previewSlides = $previewSlides.Count
    }
    Add-Result 'PPTX_PREVIEW' 'PASS' "pptxPreview.status is ready with $($previewSlides.Count) slide(s) for $artifactId, equal to the $expectedSlides slide(s) in the uploaded acceptance.pptx"
}

function Invoke-StopCheck([string]$ThreadId, [string]$AgentId) {
    $before = Get-CampSnapshot $ThreadId
    $excluded = New-Object 'Collections.Generic.HashSet[string]'
    foreach ($run in @(Get-Value $before 'agentRuns')) { if ($run) { [void]$excluded.Add([string](Get-Value $run 'id')) } }
    $messageId = Send-ThreadMessage $ThreadId $AgentId `
        'Stop check: write a long, slow answer. Produce at least 800 words and keep working until you are interrupted.' @()
    $running = Wait-Until -TimeoutSeconds 60 -IntervalMilliseconds 200 -Probe {
        $snapshot = Get-CampSnapshot $ThreadId
        $run = Get-NewRun $snapshot $messageId $excluded
        if (-not $run) { return $null }
        $status = [string](Get-Value $run 'status')
        if ($status -eq 'running') { return $run }
        if (@('succeeded', 'failed', 'cancelled') -contains $status) { return 'terminal' }
        return $null
    }
    if ($null -eq $running) { throw 'no AgentRun appeared for the stop check.' }
    if ($running -is [string]) {
        Add-Result 'STOP' 'FAIL' 'stop API was not exercised because the run reached terminal state before cancellation'
        return
    }
    $cancelled = Invoke-CoreRequest 'agentRuns.cancel' ([ordered]@{
            commandId = New-CommandId
            command = [ordered]@{
                threadId = $ThreadId
                agentRunId = [string](Get-Value $running 'id')
                expectedVersion = Get-Value $running 'version'
            }
        })
    if ([string](Get-Value $cancelled 'status') -eq 'rejected') {
        throw "agentRuns.cancel was rejected: $(Hide-Secrets ([string](Get-Value $cancelled 'code')))"
    }
    $settled = Wait-Until -TimeoutSeconds $StopTimeoutSeconds -IntervalMilliseconds 300 -Probe {
        $snapshot = Get-CampSnapshot $ThreadId
        foreach ($run in @(Get-Value $snapshot 'agentRuns')) {
            if ($run -and [string](Get-Value $run 'id') -eq [string](Get-Value $running 'id')) {
                if (@('succeeded', 'failed', 'cancelled') -contains [string](Get-Value $run 'status')) { return $run }
            }
        }
        return $null
    }
    if (-not $settled) { throw "the cancelled AgentRun did not settle within $StopTimeoutSeconds s." }
    $status = [string](Get-Value $settled 'status')
    if ($status -ne 'cancelled') { throw "agentRuns.cancel left the Run $status." }
    $script:Evidence['stop'] = [ordered]@{
        threadId = $ThreadId
        agentRunId = [string](Get-Value $settled 'id')
        finalStatus = $status
        cancelAcknowledgedAt = Get-Value $settled 'cancelAcknowledgedAt'
    }
    Add-Result 'STOP' 'PASS' "agentRuns.cancel settled the Run as cancelled"
}

# --------------------------------------------------------------------------------------
# -InstallOnly steps (CI): member reuse, a real pptx upload, and a model-free STOP
# --------------------------------------------------------------------------------------

function Get-RunById([string]$ThreadId, [string]$RunId) {
    foreach ($run in @(Get-Value (Get-CampSnapshot $ThreadId) 'agentRuns')) {
        if ($run -and [string](Get-Value $run 'id') -eq $RunId) { return $run }
    }
    return $null
}

function Select-InstallOnlyMember {
    # Reuse whatever the personal roster already holds and only create a member when the
    # roster stays empty. A pi-adapted member is preferred because it is the member the
    # real-machine run configures, but any mentionable member is enough here: install-only
    # mode configures no model, so members.runtime.set is never sent.
    $selected = Wait-Until -TimeoutSeconds 45 -IntervalMilliseconds 1500 -Probe {
        try { $members = @(Invoke-CoreRequest 'members.list' ([ordered]@{})) }
        catch { $members = @() }
        $fallback = $null
        foreach ($member in $members) {
            if (-not $member) { continue }
            $candidate = [string](Get-Value $member 'agentId')
            if (-not $candidate) { continue }
            $adapterKind = [string](Get-Value (Get-Value $member 'runtimeConfiguration') 'adapterKind')
            if ($adapterKind -eq 'pi') {
                return [pscustomobject]@{ agentId = $candidate; adapterKind = $adapterKind }
            }
            if (-not $fallback) {
                $fallback = [pscustomobject]@{ agentId = $candidate; adapterKind = $adapterKind }
            }
        }
        if ($null -ne $fallback) { return $fallback }
        return $null
    }
    $agentId = $null
    $adapterKind = ''
    if ($null -ne $selected) {
        $agentId = [string](Get-Value $selected 'agentId')
        $adapterKind = [string](Get-Value $selected 'adapterKind')
        $reported = if ($adapterKind) { $adapterKind } else { 'none reported' }
        Add-Result 'MEMBER_CREATE' 'SKIP' ("member {0} is already present (adapter {1}); members.create was not called" -f $agentId, $reported)
    } else {
        $agentId = New-PiAssistant
        Add-Result 'MEMBER_CREATE' 'PASS' "members.create created member $agentId"
    }
    Add-Result 'MEMBER_MODEL' 'N/A' 'install-only mode: provider credential and model lane are out of scope; members.runtime.set was not called'
    $script:Evidence['member'] = [ordered]@{
        agentId = $agentId
        adapterKind = $adapterKind
        modelId = $null
        mode = 'install-only (no members.runtime.set)'
    }
    return $agentId
}

function Invoke-PptxUploadInstallOnly([string]$ThreadId) {
    # The same minimal OOXML file the real-machine run uploads, through the same upload
    # endpoint. Nothing is copied into a quick-chat workspace and no Mission is created.
    $marker = 'LOOM-PPTX-MARKER-' + (Get-Random -Minimum 100000 -Maximum 999999)
    $path = Join-Path $script:Paths['files'] 'acceptance.pptx'
    [void](New-PptxFile $path ("$marker slide one."))
    $expectedSlides = Get-PptxSlideCount $path
    $draft = Invoke-Upload $ThreadId $path 'acceptance.pptx'
    $sourcePath = [string](Get-Value $draft 'sourcePath')
    if (-not $sourcePath) { throw 'the pptx upload returned no source path.' }
    if (-not [IO.File]::Exists($sourcePath)) { throw "the uploaded pptx source is not readable: $sourcePath" }
    $uploadedSlides = Get-PptxSlideCount $sourcePath
    if ($uploadedSlides -ne $expectedSlides) {
        throw ("the uploaded pptx at {0} declares {1} slide(s), not the {2} slide(s) written by this run." -f `
                $sourcePath, $uploadedSlides, $expectedSlides)
    }
    $localSha = Get-FileSha256 $path
    $uploadedSha = Get-FileSha256 $sourcePath
    if ($uploadedSha -cne $localSha) {
        throw ("the uploaded pptx bytes ({0}) are not the generated acceptance.pptx ({1})." -f $uploadedSha, $localSha)
    }
    $expectedBytes = (Get-Item -LiteralPath $path).Length
    $observedBytes = Get-Value $draft 'observedByteSize'
    if ($null -ne $observedBytes -and [int64]$observedBytes -ne [int64]$expectedBytes) {
        throw ("the upload observed {0} byte(s) but the generated pptx is {1} byte(s)." -f $observedBytes, $expectedBytes)
    }
    $attachmentId = [string](Get-Value $draft 'id')
    $script:Evidence['pptxUpload'] = [ordered]@{
        attachmentId = $attachmentId
        sourcePath = $sourcePath
        sha256 = $localSha
        slides = $expectedSlides
        byteSize = [int64]$expectedBytes
        mode = 'install-only (upload only, no Mission, no preview)'
    }
    Add-Result 'PPTX_UPLOAD' 'PASS' ("uploaded acceptance.pptx as {0} from {1}: {2} slide(s), sha256 {3}, {4} byte(s)" -f `
            $attachmentId, $sourcePath, $uploadedSlides, $uploadedSha, $expectedBytes)
}

function Invoke-StopCheckInstallOnly([string]$ThreadId, [string]$AgentId) {
    # No provider credential exists in install-only mode, so the Run this message creates is
    # expected to stay queued/waiting (it never has to reach running). thread.messages.send
    # and agentRuns.cancel are still the real Web/API control path: a Run that is never
    # created, a cancel that is rejected or a Run that does not end cancelled is a FAIL, and
    # no PASS is ever recorded without observing the cancelled Run.
    $terminal = @('succeeded', 'failed', 'cancelled')
    $before = Get-CampSnapshot $ThreadId
    $excluded = New-Object 'Collections.Generic.HashSet[string]'
    foreach ($run in @(Get-Value $before 'agentRuns')) { if ($run) { [void]$excluded.Add([string](Get-Value $run 'id')) } }

    try {
        $messageId = Send-ThreadMessage $ThreadId $AgentId `
            'Stop check: do not answer this message. It exists only to create the AgentRun this acceptance cancels through agentRuns.cancel.' @()
    } catch {
        Add-Result 'STOP' 'FAIL' ('install-only stop check could not send thread.messages.send: ' + (Hide-Secrets $_.Exception.Message))
        return
    }

    $deadline = (Get-Date).AddSeconds($StopTimeoutSeconds)
    $run = $null
    while (-not $run -and (Get-Date) -lt $deadline) {
        $run = Get-NewRun (Get-CampSnapshot $ThreadId) $messageId $excluded
        if (-not $run) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $run) {
        Add-Result 'STOP' 'FAIL' ("thread.messages.send created no AgentRun within {0} s, so agentRuns.cancel had nothing to cancel" -f $StopTimeoutSeconds)
        return
    }

    $runId = [string](Get-Value $run 'id')
    $status = [string](Get-Value $run 'status')
    $observed = New-Object 'Collections.Generic.List[string]'
    [void]$observed.Add($status)
    $cancelCommands = 0
    while ($terminal -notcontains $status -and $cancelCommands -lt 5 -and (Get-Date) -lt $deadline) {
        $cancelCommands++
        $reply = Try-CoreRequest 'agentRuns.cancel' ([ordered]@{
                commandId = New-CommandId
                command = [ordered]@{
                    threadId = $ThreadId
                    agentRunId = $runId
                    expectedVersion = Get-Value $run 'version'
                }
            })
        if (-not $reply.Ok) {
            $code = [string]$reply.Code
            if (-not $code) { $code = 'transport' }
            # A concurrent status/version bump is not a rejection of the control path: the
            # Run is re-read and cancelled again with its current version.
            $current = Get-RunById $ThreadId $runId
            if ($code -notlike '*version_conflict*' -or -not $current) {
                Add-Result 'STOP' 'FAIL' ("agentRuns.cancel was rejected for run {0}: {1}" -f $runId, (Hide-Secrets $code))
                return
            }
            $run = $current
        } else {
            $settled = Wait-Until -TimeoutSeconds 30 -IntervalMilliseconds 200 -Probe {
                $candidate = Get-RunById $ThreadId $runId
                if ($candidate -and $terminal -contains [string](Get-Value $candidate 'status')) { return $candidate }
                return $null
            }
            if ($settled) { $run = $settled } else { $run = Get-RunById $ThreadId $runId }
            if (-not $run) {
                Add-Result 'STOP' 'FAIL' ("AgentRun {0} disappeared from camps.open after agentRuns.cancel" -f $runId)
                return
            }
        }
        $status = [string](Get-Value $run 'status')
        if ($observed -notcontains $status) { [void]$observed.Add($status) }
    }

    $firstStatus = [string]$observed[0]
    $current = Get-RunById $ThreadId $runId
    if ($status -eq 'cancelled') {
        $script:Evidence['stop'] = [ordered]@{
            threadId = $ThreadId
            agentRunId = $runId
            observedStatuses = @($observed)
            finalStatus = $status
            cancelCommands = $cancelCommands
            cancelAcknowledgedAt = Get-Value $current 'cancelAcknowledgedAt'
            mode = 'install-only (model-free queued/nonterminal cancel control path)'
        }
        Add-Result 'STOP' 'PASS' ("model-free queued/nonterminal cancel control path: thread.messages.send created Run {0} ({1}) and agentRuns.cancel settled it cancelled after {2} cancel command(s)" -f `
                $runId, $firstStatus, $cancelCommands)
        return
    }
    if ($cancelCommands -eq 0 -and $terminal -contains $status) {
        Add-Result 'STOP' 'FAIL' ("the AgentRun {0} was already {1} when it was first observed, so agentRuns.cancel could not cancel it and the cancel control path is unproven" -f `
                $runId, $status)
        return
    }
    if ($terminal -contains $status) {
        Add-Result 'STOP' 'FAIL' ("agentRuns.cancel left the AgentRun {0} {1}, not cancelled" -f $runId, $status)
        return
    }
    Add-Result 'STOP' 'FAIL' ("the AgentRun {0} stayed {1} {2} s after agentRuns.cancel and never reached cancelled" -f `
            $runId, $status, $StopTimeoutSeconds)
}

# --------------------------------------------------------------------------------------
# log collection
# --------------------------------------------------------------------------------------

function Clear-SecretFromFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $text = [IO.File]::ReadAllText($Path)
    $hidden = Hide-Secrets $text
    if ($hidden -ne $text) { [IO.File]::WriteAllText($Path, $hidden, $script:Utf8) }
}

function Write-AcceptanceArtifacts {
    $logRoot = $script:Paths['logs']
    foreach ($name in @('install.out.txt', 'install.err.txt', 'server.out.txt', 'server.err.txt')) {
        Clear-SecretFromFile (Join-Path $logRoot $name)
    }
    if ($script:InstallDirectory -and (Test-Path -LiteralPath $script:InstallDirectory)) {
        Get-ChildItem -LiteralPath $script:InstallDirectory -Force |
            Select-Object Name, Length, LastWriteTime |
            Format-Table -AutoSize | Out-String |
            Set-Content -LiteralPath (Join-Path $logRoot 'install-dir.txt') -Encoding UTF8
        $statePath = Join-Path $script:InstallDirectory 'installation.json'
        if (Test-Path -LiteralPath $statePath) {
            Copy-Item -LiteralPath $statePath -Destination (Join-Path $logRoot 'installation.json') -Force
        }
    }
    if ($script:DataDirectory -and (Test-Path -LiteralPath $script:DataDirectory)) {
        Get-ChildItem -LiteralPath $script:DataDirectory -Force |
            Select-Object Name, Length, LastWriteTime |
            Format-Table -AutoSize | Out-String |
            Set-Content -LiteralPath (Join-Path $logRoot 'data-dir.txt') -Encoding UTF8
    }
    $failed = @($script:Results | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0
    # Every status is counted as reported, N/A included: a step that does not belong to this
    # mode is never folded into PASS or FAIL.
    $statusCounts = [ordered]@{}
    foreach ($entry in $script:Results) {
        $status = [string]$entry.status
        if ($statusCounts.Contains($status)) { $statusCounts[$status] = [int]$statusCounts[$status] + 1 }
        else { $statusCounts[$status] = 1 }
    }
    $credentialSource = if ($script:InstallOnly) {
        'N/A: install-only mode reads, requires and stores no provider credential'
    } else {
        'OCT_API_KEY (value never recorded)'
    }
    $summary = [ordered]@{
        kind = 'loom-windows-real-install-acceptance'
        mode = if ($script:InstallOnly) { 'install-only' } else { 'real' }
        installOnly = [bool]$script:InstallOnly
        status = if ($failed) { 'FAIL' } else { 'PASS' }
        finishedAt = (Get-Date).ToString('o')
        port = $Port
        modelId = if ($script:InstallOnly) { $null } else { $ModelId }
        modelLane = if ($script:InstallOnly) { 'N/A: install-only mode configures no member model' } else { "explicit $ModelId" }
        installDirectory = $script:InstallDirectory
        dataDirectory = $script:DataDirectory
        packageRoot = $packageRoot
        credentialSource = $credentialSource
        statusCounts = $statusCounts
        evidence = $script:Evidence
        results = $script:Results
    }
    $summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $logRoot 'summary.json') -Encoding UTF8
    $lines = New-Object 'Collections.Generic.List[string]'
    $lines.Add('LOOM Windows real-install acceptance')
    $lines.Add("finished: $((Get-Date).ToString('o'))")
    $lines.Add("install: $($script:InstallDirectory)")
    $lines.Add("data:    $($script:DataDirectory)")
    if ($script:InstallOnly) {
        $lines.Add("port:    $Port   model: N/A (install-only)")
        $lines.Add('mode:    install-only - no provider credential, no provider catalog, no member model; the model lane is covered by the cloud VM real deepseek acceptance')
    } else {
        $lines.Add("port:    $Port   model: $ModelId")
        $lines.Add('mode:    real - $env:OCT_API_KEY (value never recorded), oct-chat Pi catalog, explicit member model')
    }
    $lines.Add('')
    foreach ($status in @('PASS', 'N/A', 'FAIL', 'SKIP', 'SKIP_STOP_WINDOW')) {
        foreach ($entry in @($script:Results | Where-Object { $_.status -eq $status })) {
            $lines.Add(('{0,-18} {1}: {2}' -f $entry.status, $entry.id, $entry.detail))
        }
    }
    $lines.Add('')
    $lines.Add("exit code: $(if ($failed) { 1 } else { 0 })")
    [IO.File]::WriteAllLines((Join-Path $logRoot 'report.txt'), $lines, $script:Utf8)
    return $failed
}

# --------------------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------------------

$packageRoot = $null
$exitCode = 0
try {
    Assert-ShortWorkRoot
    Set-Content -LiteralPath (Join-Path $script:Paths['logs'] 'report.txt') -Value 'acceptance started' -Encoding UTF8

    if ($script:InstallOnly) {
        # Install-only mode never reads, requires or sets a provider credential, and it never
        # starts a provider: the model lane belongs to the cloud VM real deepseek acceptance.
        Add-Result 'CREDENTIAL' 'N/A' 'install-only mode: provider credential and model lane are out of scope'
    } else {
        # FAIL_FAST: the credential is read from the environment only and never echoed.
        $credential = $env:OCT_API_KEY
        if (-not $credential -or $credential.Trim().Length -eq 0) {
            Add-Result 'CREDENTIAL' 'FAIL' 'OCT_API_KEY is not set in this process; FAIL_FAST before install'
            $exitCode = 2
            throw 'FAIL_FAST: OCT_API_KEY is missing.'
        }
        Add-Secret $credential
        $credential = $null
        Add-Result 'CREDENTIAL' 'PASS' 'OCT_API_KEY present and held only in the process environment'
    }

    $packageRoot = Expand-Package
    Add-Result 'EXTRACT' 'PASS' "package extracted under $($script:Paths['work'])"

    Install-Package
    Add-Result 'INSTALL' 'PASS' ("installed {0} on port {1}" -f (Get-Value $script:Evidence['installation'] 'current'), $Port)

    [void](Start-LoomConsole)
    Wait-ServerReady
    Add-Result 'START' 'PASS' "installed Server answers $($script:Origin)/"

    [void](Get-AdministratorToken)
    Connect-Administrator
    Add-Result 'LOGIN' 'PASS' 'administrator token accepted by /api/v1/login'

    $agentId = if ($script:InstallOnly) { Select-InstallOnlyMember } else { Select-MemberAndModel }
    $threadId = New-Camp $agentId "Windows real install acceptance $((Get-Date).ToString('yyyyMMdd-HHmmss'))"
    Add-Result 'CAMP' 'PASS' "created thread $threadId"

    if ($script:InstallOnly) {
        # No model message, no docx turn, no Mission and no preview: those rows are N/A
        # because the model lane runs in the cloud VM real deepseek acceptance instead.
        $modelLaneDetail = 'N/A on Windows Actions: the model lane is covered by the cloud VM real deepseek acceptance; this install-only run sends no model message, no docx turn and no pptx Mission'
        foreach ($id in @('REAL_MODEL_IDENTITY', 'REAL_MODEL', 'DOCX_MARKER')) {
            Add-Result $id 'N/A' $modelLaneDetail
        }
        Invoke-PptxUploadInstallOnly $threadId
        Add-Result 'PPTX_PREVIEW' 'N/A' 'N/A on Windows Actions: no Mission and no artifact preview are created here; the pptx preview lane belongs to the cloud VM real deepseek acceptance'
        Invoke-StopCheckInstallOnly $threadId $agentId
    } else {
        Invoke-RealModelTurn $threadId $agentId
        Invoke-DocxCheck $threadId $agentId
        Test-PptxPreviewInterface $threadId $agentId
        Invoke-StopCheck $threadId $agentId
    }
} catch {
    Add-Result 'ACCEPTANCE' 'FAIL' (Hide-Secrets $_.Exception.Message)
} finally {
    try { if ($script:Launcher) { [void](Stop-LoomConsole) } } catch {
        Add-Result 'STOP_CONSOLE' 'FAIL' (Hide-Secrets $_.Exception.Message)
    }
    try {
        $failed = Write-AcceptanceArtifacts
        if ($failed -and $exitCode -eq 0) { $exitCode = 1 }
    } catch {
        Write-Host ('log collection failed: ' + (Hide-Secrets $_.Exception.Message))
        if ($exitCode -eq 0) { $exitCode = 1 }
    }
}

$passed = @($script:Results | Where-Object { $_.status -eq 'PASS' }).Count
$notApplicable = @($script:Results | Where-Object { $_.status -eq 'N/A' }).Count
$skipped = @($script:Results | Where-Object { $_.status -like 'SKIP*' }).Count
$failed = @($script:Results | Where-Object { $_.status -eq 'FAIL' }).Count
Write-Host ''
Write-Host ("acceptance: {0} PASS / {1} N/A / {2} SKIP / {3} FAIL; logs in {4}" -f $passed, $notApplicable, $skipped, $failed, $script:Paths['logs'])
exit $exitCode
