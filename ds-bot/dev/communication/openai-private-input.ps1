[CmdletBinding()]
param([switch]$CheckOnly, [switch]$Mock, [switch]$RunOnce)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# A separate -NoProfile process keeps the caller's shell environment untouched.
# A real call is possible only with the explicit -RunOnce switch.
$stageSecret = $null
$stagePlain = $null
$stageBstr = [IntPtr]::Zero
$stageProcess = $null
$stageInfo = $null
$stageRandom = $null
$stageResult = 1
$stagePhase = 'setup'

try {
  $stageNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $stageWorker = Join-Path $PSScriptRoot 'openai-private-input.mjs'
  if (([int]$CheckOnly.IsPresent + [int]$Mock.IsPresent + [int]$RunOnce.IsPresent) -gt 1) { throw 'INPUT_MODE_INVALID' }
  if ($Mock -or $RunOnce) { $stageWorker = Join-Path $PSScriptRoot 'openai-real-pilot.mjs' }
  if (-not (Test-Path -LiteralPath $stageWorker -PathType Leaf)) { throw 'INPUT_WORKER_UNAVAILABLE' }
  if ($CheckOnly -or $Mock) {
    $stageBytes = New-Object byte[] 32
    $stageRandom = [Security.Cryptography.RandomNumberGenerator]::Create()
    $stageRandom.GetBytes($stageBytes)
    $stagePlain = 'synthetic-' + [Convert]::ToBase64String($stageBytes)
    [Array]::Clear($stageBytes, 0, $stageBytes.Length)
  } else {
    if ($RunOnce) { Write-Host 'Official OpenAI gpt-6-luna synthetic pilot; at most 8 requests; no retries. Key is never saved.' }
    else { Write-Host 'INPUT CHECK ONLY: no API call; the key is discarded after validation.' }
    $stageSecret = Read-Host 'Temporary OpenAI key (hidden input)' -AsSecureString
    $stageBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($stageSecret)
    $stagePlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($stageBstr)
  }
  if ([string]::IsNullOrWhiteSpace($stagePlain) -or $stagePlain.Length -lt 16 -or $stagePlain -match '\s') {
    throw 'INPUT_INVALID'
  }
  $stageInfo = New-Object System.Diagnostics.ProcessStartInfo
  $stageInfo.FileName = $stageNode
  $stageInfo.Arguments = '"' + $stageWorker + '"'
  if ($Mock) { $stageInfo.Arguments += ' --mock' }
  if ($RunOnce) { $stageInfo.Arguments += ' --run-once' }
  $stageInfo.WorkingDirectory = $PSScriptRoot
  $stageInfo.UseShellExecute = $false
  $stageInfo.CreateNoWindow = $true
  $stageInfo.RedirectStandardOutput = $true
  $stageInfo.RedirectStandardError = $true
  # No ambient API keys, NODE_OPTIONS, proxy or TLS overrides reach this worker.
  $stageInfo.EnvironmentVariables.Clear()
  foreach ($stageName in @('SystemRoot', 'WINDIR', 'TEMP', 'TMP')) {
    $stageValue = [Environment]::GetEnvironmentVariable($stageName, 'Process')
    if ($null -ne $stageValue) { $stageInfo.EnvironmentVariables[$stageName] = $stageValue }
  }
  $stageInfo.EnvironmentVariables['DSBOT_COMMUNICATION_OPENAI_INPUT'] = $stagePlain
  $stagePhase = 'start'
  $stageProcess = New-Object System.Diagnostics.Process
  $stageProcess.StartInfo = $stageInfo
  if (-not $stageProcess.Start()) { throw 'INPUT_WORKER_START_FAILED' }
  $stagePhase = 'wait'
  $stageInfo.EnvironmentVariables.Remove('DSBOT_COMMUNICATION_OPENAI_INPUT')
  $stagePlain = $null
  if ($stageBstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($stageBstr)
    $stageBstr = [IntPtr]::Zero
  }
  if ($null -ne $stageSecret) { $stageSecret.Dispose(); $stageSecret = $null }
  $stageTimeout = 15000
  if ($Mock -or $RunOnce) { $stageTimeout = 240000 }
  if (-not $stageProcess.WaitForExit($stageTimeout)) {
    $stageProcess.Kill()
    $stageProcess.WaitForExit()
    throw 'INPUT_WORKER_TIMEOUT'
  }
  # Never relay arbitrary child stderr or raw errors that could contain secrets.
  $stageOutput = $stageProcess.StandardOutput.ReadToEnd().Trim()
  $stagePhase = 'result'
  $stageParsed = $stageOutput | ConvertFrom-Json
  if ($Mock -or $RunOnce) {
    $stageExpected = 'PASS_PILOT_MOCK'
    if ($RunOnce) { $stageExpected = 'PASS_OPENAI_PROVIDER_PILOT' }
    if ($stageProcess.ExitCode -ne 0 -or $stageParsed.status -ne $stageExpected -or -not $stageParsed.cleanup) {
      Write-Output 'PILOT_STOPPED: inspect the sanitized .dsh-test-tools/openai-authorized-pilot/result.json; no retry was started.'
      throw 'INPUT_WORKER_FAILED'
    }
    Write-Output ('PASS_BOUNDED_PILOT: requests=' + [int]$stageParsed.actualRequests + '; cases=' + [int]$stageParsed.cases + '; modeled token cost upper estimate USD=' + [double]$stageParsed.modeledGenerationCostUsdUpperBound)
  } else {
    if ($stageProcess.ExitCode -ne 0 -or $stageParsed.status -ne 'PASS_INPUT_CHANNEL_ONLY' -or $stageParsed.networkCalls -ne 0 -or
        -not $stageParsed.environmentRemoved -or -not $stageParsed.credentialDiscarded) { throw 'INPUT_WORKER_FAILED' }
    Write-Output 'PASS_INPUT_CHANNEL_ONLY: hidden/process-private input; no credential file; no API request; key discarded.'
  }
  $stageResult = 0
} catch {
  if ($CheckOnly) {
    Write-Output ('INPUT_CHECK_PHASE_' + $stagePhase + ': ' + $_.Exception.GetType().Name)
    if ($_.Exception.InnerException -is [System.ComponentModel.Win32Exception]) {
      Write-Output ('INPUT_CHECK_NATIVE_' + $_.Exception.InnerException.NativeErrorCode)
    }
  }
  Write-Output 'STOPPED: no credential details are displayed; no automatic retry.'
} finally {
  if ($null -ne $stageInfo) { $stageInfo.EnvironmentVariables.Remove('DSBOT_COMMUNICATION_OPENAI_INPUT') }
  if ($stageBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($stageBstr) }
  if ($null -ne $stageSecret) { $stageSecret.Dispose() }
  if ($null -ne $stageRandom) { $stageRandom.Dispose() }
  $stagePlain = $null
  if ($null -ne $stageProcess) {
    try { if ($stageProcess.Id -and -not $stageProcess.HasExited) { $stageProcess.Kill(); $stageProcess.WaitForExit(3000) | Out-Null } } catch {}
    $stageProcess.Dispose()
  }
}
exit $stageResult
