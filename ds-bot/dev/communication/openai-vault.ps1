#Requires -Version 5.1
[CmdletBinding()]
param([ValidateSet('Status','Verify','Set','Rotate','Delete','RunFederation','SelfTest')][string]$Action = 'Status', [switch]$ConfirmDelete)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'openai-vault-lib.ps1')
$vaultPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DS-Bot\credentials\openai-official.dpapi'
$vaultSecret = $null; $vaultPlain = $null; $vaultBstr = [IntPtr]::Zero; $vaultInfo = $null; $vaultProcess = $null; $vaultExit = 1
try {
  if ($Action -eq 'Status') {
    $configured = Test-Path -LiteralPath $vaultPath -PathType Leaf
    if ($configured) { Assert-VaultAcl $vaultPath; Assert-VaultAcl ([IO.Path]::GetDirectoryName($vaultPath)) }
    Write-Output ('OPENAI_VAULT_CONFIGURED=' + $configured + '; DPAPI=CurrentUser; endpoint=https://api.openai.com')
    $vaultExit=0
  } elseif ($Action -eq 'Verify') {
    $vaultSecret=Read-OpenAIVault $vaultPath
    if ($vaultSecret.Length -lt 16) { throw 'VAULT_INPUT_INVALID' }
    Write-Output 'OPENAI_VAULT_VERIFIED: CurrentUser DPAPI decryptable; no value displayed or transmitted.'
    $vaultExit=0
  } elseif ($Action -in @('Set','Rotate')) {
    if ((Test-Path -LiteralPath $vaultPath) -and $Action -eq 'Set') { throw 'VAULT_EXISTS_USE_ROTATE' }
    if (-not (Test-Path -LiteralPath $vaultPath) -and $Action -eq 'Rotate') { throw 'VAULT_NOT_CONFIGURED' }
    Write-Host 'DS-Bot encrypted OpenAI storage: this Windows account only; use a NEW suitable key, not the exposed temporary test key.'
    $vaultSecret = Read-Host 'New OpenAI API key (hidden input; DPAPI encrypted storage)' -AsSecureString
    Save-OpenAIVault $vaultPath $vaultSecret ($Action -eq 'Rotate')
    Write-Output 'OPENAI_VAULT_SAVED: DPAPI CurrentUser; no plaintext file or log; future runs can reuse it.'
    $vaultExit=0
  } elseif ($Action -eq 'Delete') {
    if (-not $ConfirmDelete) { throw 'VAULT_DELETE_REQUIRES_CONFIRMDELETE' }
    Remove-OpenAIVault $vaultPath
    Write-Output 'OPENAI_VAULT_REMOVED: local reuse disabled; revoke the key separately in OpenAI.'
    $vaultExit=0
  } elseif ($Action -eq 'SelfTest') {
    $testBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $testRoot=Join-Path $testBase ('dsbot-credential-test-' + [Guid]::NewGuid().ToString('n'))
    $testPath=Join-Path $testRoot 'record.dpapi'
    $testSecret=$null; $testRead=$null; $testSecond=$null
    try {
      $testPlain='synthetic-' + [Guid]::NewGuid().ToString('n')
      $testSecret=ConvertTo-SecureString $testPlain -AsPlainText -Force
      Save-OpenAIVault $testPath $testSecret $false
      if ([IO.File]::ReadAllText($testPath).Contains($testPlain)) { throw 'VAULT_TEST_PLAINTEXT' }
      $testRead=Read-OpenAIVault $testPath
      $overwriteRejected=$false
      try { Save-OpenAIVault $testPath $testSecret $false } catch { $overwriteRejected=$_.Exception.Message -eq 'VAULT_EXISTS_USE_ROTATE' }
      if (-not $overwriteRejected) { throw 'VAULT_TEST_OVERWRITE' }
      $testPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($testRead)
      try { if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($testPointer) -ne $testPlain) { throw 'VAULT_TEST_ROUNDTRIP' } }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($testPointer) }
      $testSecond=ConvertTo-SecureString ('synthetic-rotated-' + [Guid]::NewGuid().ToString('n')) -AsPlainText -Force
      Save-OpenAIVault $testPath $testSecond $true
      $testRead.Dispose(); $testRead=Read-OpenAIVault $testPath
      if ($testRead.Length -eq $testSecret.Length) { throw 'VAULT_TEST_ROTATE' }
      $goodCipher=[IO.File]::ReadAllText($testPath)
      [IO.File]::WriteAllText($testPath, 'invalid-format')
      $tamperRejected=$false
      try { $unexpected=Read-OpenAIVault $testPath; $unexpected.Dispose() } catch { $tamperRejected=$_.Exception.Message -eq 'VAULT_FORMAT_INVALID' }
      [IO.File]::WriteAllText($testPath,$goodCipher); $goodCipher=$null
      if (-not $tamperRejected) { throw 'VAULT_TEST_TAMPER' }
      $unsafeDirectory=Join-Path $testRoot 'inherited-unprotected-directory'
      [void][IO.Directory]::CreateDirectory($unsafeDirectory)
      $unsafePath=Join-Path $unsafeDirectory 'synthetic.dpapi'
      [IO.File]::Copy($testPath,$unsafePath)
      $unsafeRejected=$false
      try { $unexpected=Read-OpenAIVault $unsafePath; $unexpected.Dispose() } catch { $unsafeRejected=$_.Exception.Message -eq 'VAULT_ACL_UNSAFE' }
      if (-not $unsafeRejected) { throw 'VAULT_TEST_UNSAFE_ACL' }
      Remove-OpenAIVault $testPath
      if (Test-Path -LiteralPath $testPath) { throw 'VAULT_TEST_DELETE' }
      Write-Output 'PASS_VAULT_SELFTEST: DPAPI roundtrip, ciphertext only, owner ACL, overwrite refusal, rotation, tamper/unsafe-ACL refusal, deletion.'
      $vaultExit=0
    } finally {
      if ($null -ne $testSecret) { $testSecret.Dispose() }; if ($null -ne $testRead) { $testRead.Dispose() }; if ($null -ne $testSecond) { $testSecond.Dispose() }
      $testPlain=$null
      if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($testRoot)).TrimEnd('\') -ne $testBase.TrimEnd('\') -or -not ([IO.Path]::GetFileName($testRoot)).StartsWith('dsbot-credential-test-')) { throw 'VAULT_TEST_CLEANUP_PATH' }
      if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    }
  } else {
    $vaultWorker=Join-Path $PSScriptRoot 'openai-dsh-pilot.mjs'
    if (-not (Test-Path -LiteralPath $vaultWorker -PathType Leaf)) { throw 'FEDERATION_WORKER_NOT_READY' }
    $vaultNode=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $vaultSecret=Read-OpenAIVault $vaultPath
    $vaultBstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($vaultSecret)
    $vaultPlain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($vaultBstr)
    if ($vaultPlain -match '\s' -or $vaultPlain.Length -lt 16) { throw 'VAULT_INPUT_INVALID' }
    $vaultInfo=New-Object Diagnostics.ProcessStartInfo
    $vaultInfo.FileName=$vaultNode; $vaultInfo.Arguments='"' + $vaultWorker + '" --real'
    $vaultInfo.WorkingDirectory=$PSScriptRoot; $vaultInfo.UseShellExecute=$false; $vaultInfo.CreateNoWindow=$true
    $vaultInfo.RedirectStandardOutput=$true; $vaultInfo.RedirectStandardError=$true
    $vaultInfo.EnvironmentVariables.Clear()
    foreach ($vaultName in @('SystemRoot','WINDIR','TEMP','TMP')) {
      $vaultValue=[Environment]::GetEnvironmentVariable($vaultName,'Process')
      if ($null -ne $vaultValue) { $vaultInfo.EnvironmentVariables[$vaultName]=$vaultValue }
    }
    $vaultInfo.EnvironmentVariables['PATH']=[IO.Path]::GetDirectoryName($vaultNode) + ';' + $env:WINDIR + '\System32;' + $env:WINDIR + '\System32\WindowsPowerShell\v1.0'
    $vaultInfo.EnvironmentVariables['DSBOT_COMMUNICATION_OPENAI_INPUT']=$vaultPlain
    $vaultProcess=New-Object Diagnostics.Process; $vaultProcess.StartInfo=$vaultInfo
    if (-not $vaultProcess.Start()) { throw 'FEDERATION_START_FAILED' }
    $vaultInfo.EnvironmentVariables.Remove('DSBOT_COMMUNICATION_OPENAI_INPUT'); $vaultPlain=$null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($vaultBstr); $vaultBstr=[IntPtr]::Zero; $vaultSecret.Dispose();$vaultSecret=$null
    if (-not $vaultProcess.WaitForExit(900000)) { $vaultProcess.Kill(); throw 'FEDERATION_TIMEOUT' }
    $vaultResult=$vaultProcess.StandardOutput.ReadToEnd().Trim() | ConvertFrom-Json
    if ($vaultProcess.ExitCode -ne 0 -or $vaultResult.status -ne 'PASS_REAL_DSH_HUB') { throw 'FEDERATION_STOPPED_SEE_SANITIZED_RESULT' }
    Write-Output ('PASS_REAL_DSH_HUB: requests=' + [int]$vaultResult.requests + '; no credential in DSH/tool processes; owned tests stopped.')
    $vaultExit=0
  }
} catch {
  if ($Action -eq 'SelfTest') { Write-Output ('VAULT_TEST_DIAGNOSTIC: type=' + $_.Exception.GetType().Name + '; line=' + $_.InvocationInfo.ScriptLineNumber) }
  $vaultCode='VAULT_OPERATION_FAILED'
  if ($_.Exception.Message -match '^(VAULT_[A-Z_]+|FEDERATION_[A-Z_]+)$') { $vaultCode=$_.Exception.Message }
  Write-Output ('STOPPED: ' + $vaultCode + '; no credential details displayed.')
} finally {
  if ($null -ne $vaultInfo) { $vaultInfo.EnvironmentVariables.Remove('DSBOT_COMMUNICATION_OPENAI_INPUT') }
  if ($vaultBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($vaultBstr) }
  if ($null -ne $vaultSecret) { $vaultSecret.Dispose() };$vaultPlain=$null
  if ($null -ne $vaultProcess) {
    try { if ($vaultProcess.Id -and -not $vaultProcess.HasExited) { $vaultProcess.Kill(); $vaultProcess.WaitForExit(3000) | Out-Null } } catch {}
    $vaultProcess.Dispose()
  }
}
exit $vaultExit
