# Encrypted OpenAI credential reuse proposal

Historical design: the owner subsequently approved and configured the DPAPI
record, and real full-chain acceptance passed. See
[current implementation, commands and evidence](openai-encrypted-reuse.md).
The design-only status below records the state before that explicit approval.

Status: **READ_ONLY_DESIGN / NO_CREDENTIAL_SAVED**. The owner requested encrypted
reuse after the completed temporary pilot. The parent requires a specific
action-time confirmation before creating/configuring persistent credentials.
No existing credential values or personal DSH profiles were inspected, no new
key was generated and no credential-storage action was performed.

## Existing DSH option

The installed `@deepseek-ai/dsh-credentials-local` public README documents
`$DSH_HOME/.credentials.yaml`, `ctx.credentials.set/unset/describe`, credential
references and saved-file precedence over environment/.env. Its protections are
owner-only file access, not an encrypted vault; tools running as the same OS user
can read it. Therefore saving through the ordinary local provider would not
satisfy a promise of encrypted-at-rest storage. Do not copy the temporary key
into that file, a project profile or an environment file.

## Recommended minimal Windows design

Use Windows **DPAPI CurrentUser**, with an owner-restricted encrypted blob at:

`%LOCALAPPDATA%\DS-Bot\credentials\openai-official.dpapi`

This is outside Git, test profiles and the repository. Do not use the machine-wide
DPAPI flag, a repository AES key, `setx`, clipboard history or a background service.
PowerShell's existing `ConvertFrom-SecureString` without `Key` uses DPAPI; the
native Windows APIs also expose the user scope directly.
[Microsoft PowerShell documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring?view=powershell-7.6),
[Microsoft DPAPI documentation](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata).

After confirmation, a trusted local credential launcher would prompt once with
hidden input, encrypt in memory and atomically write only ciphertext with a
restricted ACL. Separate nonsecret format/version/provider metadata would bind
the reference to the official OpenAI origin. A selected local DS-Bot official
OpenAI connection could reuse it without typing each time: decrypt only inside
the dedicated credential/exit-guard process and give model/tool host children
only a distinct local nonce. Missing/decryption failure must stop rather than
fall back to another provider, ambient credentials or plaintext files. Storage
does not authorize new runs, change the model, raise a budget or reset a ledger.

Accessible subjects: the current Windows logon account can decrypt, as can
programs acting with that account's authority; administrator compromise or
malware remains a risk. DPAPI normally binds data to the user and machine, with
documented roaming exceptions. This provides encryption at rest, **not isolation
from an Agent or another app running as the same Windows user**. Do not promise
the latter without a separately authorized security boundary.

Windows Credential Manager Generic credentials are an alternative user-scoped
store, using a distinct target such as `DS-Bot/OpenAI/Official`. It still requires
an integration with the documented DSH credential seam and does not create an
application-exclusive security boundary. No `CredWrite` or credential lookup was
performed. [Microsoft Credential Manager API](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew).

## Use, rotation and removal

- Use only for the owner's selected official-OpenAI DS-Bot connection; never send
  the key to a different origin or make it available to the model prompt/tools.
- Status UI reports configured/missing/provider only, never plaintext, prefix,
  hash or key length. Keep ciphertext out of repository backups and diagnostics.
- Rotation replaces the one encrypted record through hidden input after the
  required confirmation. No plaintext temporary file or log may exist.
- Local removal deletes the encrypted record and disables reuse after confirming
  that action. Actual revocation remains in the OpenAI account console; deleting
  a local blob alone does not revoke a key or invalidate another copy.
- Use a separate suitable key for long-term reuse. Do not silently promote the
  temporary key exposed in chat into a long-lived credential. The completed
  pilot requires no further input or stored credential.

## Concrete pending action for parent confirmation

Confirm creation of **one DPAPI CurrentUser encrypted OpenAI record at the exact
path above**, readable through the selected local official-OpenAI launcher,
with no account permission expansion, no new service and no additional API call.
The owner would privately enter a suitable replacement key once. Before the
actual write, verify the Windows identity/path/ACL and use the required supported
approval flow for the location outside the workspace. No save is pending in a
tool and no approval rejection has occurred in this design-only phase.
