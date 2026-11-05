Set-StrictMode -Version Latest
# GUI-launched Windows PowerShell can inherit a different PSModulePath from PS7.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$script:VaultHeader = 'DSBOT-OPENAI-DPAPI-CURRENTUSER-1'
$script:VaultSid = [Security.Principal.WindowsIdentity]::GetCurrent().User

function Assert-VaultPath([string]$Path) {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'VAULT_WINDOWS_REQUIRED' }
  $itemPath = [IO.Path]::GetFullPath($Path)
  while ($itemPath) {
    if (Test-Path -LiteralPath $itemPath) {
      $item = Get-Item -LiteralPath $itemPath -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'VAULT_REPARSE_POINT' }
    }
    $parentPath = [IO.Path]::GetDirectoryName($itemPath)
    if ($parentPath -eq $itemPath) { break }
    $itemPath = $parentPath
  }
}
function New-VaultAcl([bool]$Directory) {
  if ($Directory) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($script:VaultSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($script:VaultSid, 'FullControl', 'Allow')
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($script:VaultSid)
  $acl.AddAccessRule($rule)
  return $acl
}
function Assert-VaultAcl([string]$Path) {
  Assert-VaultPath $Path
  $acl = Get-Acl -LiteralPath $Path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $script:VaultSid.Value -or -not $acl.AreAccessRulesProtected) { throw 'VAULT_ACL_UNSAFE' }
  $rules = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $script:VaultSid.Value -or $rules[0].AccessControlType -ne 'Allow') { throw 'VAULT_ACL_UNSAFE' }
}
function Initialize-VaultDirectory([string]$Path) {
  Assert-VaultPath $Path
  $directory = [IO.Path]::GetDirectoryName($Path)
  if (-not (Test-Path -LiteralPath $directory)) {
    [void][IO.Directory]::CreateDirectory($directory)
    try { Set-Acl -LiteralPath $directory -AclObject (New-VaultAcl $true) } catch { throw 'VAULT_DIRECTORY_PERMISSION_SETUP_FAILED' }
  }
  Assert-VaultAcl $directory
}
function Save-OpenAIVault([string]$Path, [Security.SecureString]$Secret, [bool]$Replace) {
  Initialize-VaultDirectory $Path
  $exists = Test-Path -LiteralPath $Path
  if ($exists -and -not $Replace) { throw 'VAULT_EXISTS_USE_ROTATE' }
  if (-not $exists -and $Replace) { throw 'VAULT_NOT_CONFIGURED' }
  if ($exists) { Assert-VaultAcl $Path }
  if ($Secret.Length -lt 16) { throw 'VAULT_INPUT_INVALID' }
  $ciphertext = ConvertFrom-SecureString -SecureString $Secret
  $temporary = Join-Path ([IO.Path]::GetDirectoryName($Path)) ([IO.Path]::GetRandomFileName())
  try {
    [IO.File]::WriteAllText($temporary, ($script:VaultHeader + "`n" + $ciphertext), [Text.UTF8Encoding]::new($false))
    try { Set-Acl -LiteralPath $temporary -AclObject (New-VaultAcl $false) } catch { throw 'VAULT_FILE_PERMISSION_SETUP_FAILED' }
    Assert-VaultAcl $temporary
    if ($exists) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) } else { [IO.File]::Move($temporary, $Path) }
    Assert-VaultAcl $Path
  } finally { $ciphertext = $null; if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) } }
}
function Read-OpenAIVault([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'VAULT_NOT_CONFIGURED' }
  Assert-VaultAcl ([IO.Path]::GetDirectoryName($Path))
  Assert-VaultAcl $Path
  if ((Get-Item -LiteralPath $Path).Length -gt 65536) { throw 'VAULT_FORMAT_INVALID' }
  $parts = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8).Split("`n",2)
  if ($parts.Count -ne 2 -or $parts[0] -ne $script:VaultHeader) { throw 'VAULT_FORMAT_INVALID' }
  try { return ConvertTo-SecureString -String $parts[1] -ErrorAction Stop }
  finally { $parts = $null }
}
function Remove-OpenAIVault([string]$Path) {
  Assert-VaultAcl $Path
  [IO.File]::Delete($Path)
}
