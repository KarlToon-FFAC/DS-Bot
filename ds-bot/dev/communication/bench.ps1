#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status')][string]$Action = 'status',
    [ValidatePattern('^[a-z0-9-]+$')][string]$Name = 'communication-a',
    [ValidateRange(1024, 65535)][int]$WebPort = 3101,
    [ValidateRange(1024, 65535)][int]$MockPort = 8801
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$plugin = Join-Path $repo 'ds-bot'
$data = Join-Path $repo ".dsh-test-$Name"
$manifest = Join-Path $data 'processes.json'
$node = (Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source
if ($WebPort -eq 3080 -or $MockPort -eq 3080 -or $WebPort -eq $MockPort) { throw 'Choose distinct test ports; 3080 is reserved.' }

function Read-Manifest {
    if (Test-Path -LiteralPath $manifest) { return Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json }
    return @()
}
function Owned-Process($entry) {
    $process = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    $started = $process.StartTime
    if (-not $started -or $started.ToUniversalTime().Ticks.ToString() -ne $entry.startedTicks -or $process.Path -ne $node) { return $null }
    $command = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.id)"
    if (-not $command -or -not $command.CommandLine -or -not $command.CommandLine.Contains($entry.script)) { return $null }
    return $process
}
if ($Action -eq 'status') {
    foreach ($entry in @(Read-Manifest)) {
        $process = Owned-Process $entry
        [pscustomobject]@{ Name = $entry.name; Id = $entry.id; Running = [bool]$process; Port = $entry.port }
    }
    return
}
if ($Action -eq 'stop') {
    foreach ($entry in @((Read-Manifest) | Sort-Object name -Descending)) {
        $process = Owned-Process $entry
        if ($process) { Stop-Process -Id $process.Id; $process.WaitForExit(10000) | Out-Null }
        Write-Host "$($entry.name): stopped"
    }
    Write-Host 'Test data retained for recovery.'
    return
}
foreach ($entry in @(Read-Manifest)) { if (Owned-Process $entry) { throw 'Bench already running; use status or stop.' } }
foreach ($port in @($WebPort, $MockPort)) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "Port $port is already in use." }
}
if (-not (Test-Path -LiteralPath (Join-Path $plugin 'dev/harness/node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
    throw 'Run npm ci and npm run harness in ds-bot first.'
}
[void][IO.Directory]::CreateDirectory($data)
[void][IO.Directory]::CreateDirectory((Join-Path $data 'workspace'))
$communication = ''
if ($env:DSBOT_COMMUNICATION_CONFIG) {
    $config = $env:DSBOT_COMMUNICATION_CONFIG | ConvertFrom-Json
    $allowed = @('enabled','url','credentialEnv','publishedBotIds','humanDisplayName','instanceId','autoAcceptBotInvites','pollMs','contextHistoryBytes','rotateTokens')
    foreach ($property in $config.PSObject.Properties.Name) { if ($property -notin $allowed) { throw 'Unexpected public communication setting.' } }
    $uri = [Uri]$config.url
    if (-not $uri.IsLoopback -or $uri.Scheme -notin @('ws','wss') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'The bench requires a credential-free loopback communication URL.' }
    $communication = '    communication: ' + ($config | ConvertTo-Json -Depth 6 -Compress)
}
$overlay = @'
- id: session-log-deepseek
  config:
    enabled: false
- id: bot
  config:
    checkRatio: 0.45
- id: llm-deepseek
  config:
    models:
      - { id: deepseek-flash, contextWindow: 100000, maxTokens: 8000, inputModalities: [text, image] }
      - { id: deepseek-v4-pro, contextWindow: 100000, maxTokens: 8000 }
'@
$overlay = $overlay.Replace('    checkRatio: 0.45', ('    checkRatio: 0.45' + [Environment]::NewLine + $communication))
if ($env:DSBOT_COMMUNICATION_ONBOARDING_FIXTURE -eq '1') {
    if ($communication) { throw 'The fresh onboarding fixture cannot use legacy communication configuration.' }
    # The public Config Editor must own this entry in the ordinary profile.
    $overlay = $overlay -replace '(?m)^- id: bot\r?\n  config:\r?\n    checkRatio: 0\.45\r?\n', ''
}
if ($env:DSBOT_OPENAI_GUARD_URL) {
    $guardUri = [Uri]$env:DSBOT_OPENAI_GUARD_URL
    if ($guardUri.Scheme -ne 'http' -or $guardUri.Host -ne '127.0.0.1' -or $guardUri.AbsolutePath -ne '/v1' -or $guardUri.Query -or $guardUri.Fragment -or $guardUri.UserInfo -or $env:DSBOT_OPENAI_LOCAL.Length -lt 32) { throw 'Invalid isolated OpenAI guard.' }
    $openaiOverlay = @'
- id: session-title-llm
  disabled: true
- id: llm-pi-ai
  config:
    providers:
      comm-openai-pilot:
        api: openai-responses
        baseURL: GUARD_URL
        apiKeyEnv: DSBOT_OPENAI_LOCAL
        reasoning: off
        transport: sse
        cacheRetention: none
        timeoutMs: 60000
        streamIdleTimeoutMs: 60000
        retryPolicy: { mode: normal, maxRetries: 0 }
        models:
          - id: gpt-6-luna
            contextWindow: 1050000
            maxTokens: 1024
            input: [text]
            reasoningEfforts: { off: none, low: low }
'@
    $overlay += [Environment]::NewLine + $openaiOverlay.Replace('GUARD_URL', $guardUri.AbsoluteUri.TrimEnd('/'))
}
[IO.File]::WriteAllText((Join-Path $data 'bench.patch.yml'), $overlay, [Text.UTF8Encoding]::new($false))
$variables = @('DSH_HOME','MOCK_PORT','MOCK_LOG','MOCK_DELAY_MS','DEEPSEEK_BASE_URL','DEEPSEEK_API_KEY','DSH_TELEMETRY_DISABLED','DSBOT_COMMUNICATION_PROBE','DSBOT_COMMUNICATION_TEST_LOOPBACK','DSBOT_WEB_PORT','NO_PROXY')
$saved = @{}
foreach ($key in $variables) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
$started = @()
function Start-One([string]$ProcessName, [string]$Script, [int]$Port) {
    $out = Join-Path $data "$ProcessName.log"
    $err = Join-Path $data "$ProcessName.err"
    $process = Start-Process -FilePath $node -ArgumentList @('"' + $Script + '"') -WindowStyle Hidden -WorkingDirectory (Join-Path $data 'workspace') -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    $entry = [pscustomobject]@{ name = $ProcessName; id = $process.Id; startedTicks = $process.StartTime.ToUniversalTime().Ticks.ToString(); script = $Script; port = $Port }
    return $entry
}
try {
    $env:DSH_HOME = $data
    $env:MOCK_PORT = "$MockPort"
    $env:MOCK_LOG = Join-Path $data 'mock.jsonl'
    $env:MOCK_DELAY_MS = '300'
    $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:$MockPort/v1"
    $env:DEEPSEEK_API_KEY = 'mock-key'
    $env:DSH_TELEMETRY_DISABLED = '1'
    $env:DSBOT_COMMUNICATION_PROBE = '1'
    $env:DSBOT_COMMUNICATION_TEST_LOOPBACK = '1'
    $env:DSBOT_WEB_PORT = "$WebPort"
    $env:NO_PROXY = 'localhost,127.0.0.1,::1'
    $communicationKey = $env:DSBOT_COMMUNICATION_CREDENTIAL
    Remove-Item Env:DSBOT_COMMUNICATION_CREDENTIAL -ErrorAction SilentlyContinue
    try { $started += Start-One 'mock' (Join-Path $plugin 'dev/mock-llm.mjs') $MockPort }
    finally { $env:DSBOT_COMMUNICATION_CREDENTIAL = $communicationKey }
    $started | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath $manifest
    $started += Start-One 'web' (Join-Path $PSScriptRoot 'host.mjs') $WebPort
    $started | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath $manifest
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        foreach ($entry in $started) { if (-not (Owned-Process $entry)) { throw "$($entry.name) exited; inspect its isolated logs (which may contain launch tokens)." } }
        $ready = (Test-Path -LiteralPath (Join-Path $data 'web.log')) -and
            ((Get-Content -Raw -LiteralPath (Join-Path $data 'web.log')) -match 'dsh web: http')
        if ($ready) { Write-Host "Ready: http://127.0.0.1:$WebPort (login token is only in the local web.log)"; return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Bench startup timed out; inspect isolated logs.'
} catch {
    foreach ($entry in $started) { $process = Owned-Process $entry; if ($process) { Stop-Process -Id $process.Id } }
    throw
} finally {
    foreach ($key in $variables) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
}
