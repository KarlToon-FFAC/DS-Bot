# Encrypted reuse and actual DSH/Hub acceptance

Status: **PASS_REAL_DSH_HUB / DPAPI_CONFIGURED**, 2026-11-03.
The owner explicitly approved persistent CurrentUser encryption and a subsequent
full real-model chain using a newly entered key. The credential is saved and
decryptability was verified without exposing its value. Do not request it again.

## Storage and use

The sole real credential record is:

`%LOCALAPPDATA%\DS-Bot\credentials\openai-official.dpapi`

It contains a version header and Windows DPAPI CurrentUser ciphertext. The file
and its directory use a protected ACL owned by `<current Windows user>`,
with a single full-control allow entry for that user. No API key is in Git,
`.env`, DSH's plaintext credential provider, process arguments or test logs.
Status reports metadata only; Verify decrypts into a SecureString inside its
process and reports only success/failure. There is no plaintext export action.

The launcher decrypts for a selected test only, puts the value into one child
process's private environment and immediately removes its own reference. The
Node guard consumes/deletes that environment entry before creating DSH/Hub
children. Only that guard holds the real key and sends it to the pinned official
OpenAI endpoint. DSH receives a different ephemeral loopback nonce. There is no
installed service or machine-wide environment variable.

This provides encryption at rest, **not isolation from other programs running
as the same Windows account or an administrator**. DPAPI usually binds data to
the user and machine; documented roaming exceptions exist. Runtime plaintext
copies are transient managed memory, not a promise of forensic RAM erasure.
[Microsoft DPAPI documentation](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata).

Run in the repository root (or use the absolute script path):

```powershell
# Metadata only; no decryption or network:
powershell.exe -NoLogo -NoProfile -File ds-bot/dev/communication/openai-vault.ps1 -Action Status
# Decryptability only; no value displayed and no network:
powershell.exe -NoLogo -NoProfile -File ds-bot/dev/communication/openai-vault.ps1 -Action Verify
# Hidden input once; refuse overwriting an existing record:
powershell.exe -NoLogo -NoProfile -File ds-bot/dev/communication/openai-vault.ps1 -Action Set
# Replace atomically with a newly entered key:
powershell.exe -NoLogo -NoProfile -File ds-bot/dev/communication/openai-vault.ps1 -Action Rotate
# Explicit local deletion; revoke the API key separately in OpenAI:
powershell.exe -NoLogo -NoProfile -File ds-bot/dev/communication/openai-vault.ps1 -Action Delete -ConfirmDelete
# Synthetic encrypted lifecycle only, including cleanup of its temporary files:
powershell.exe -NoLogo -NoProfile -NonInteractive -File ds-bot/dev/communication/openai-vault.ps1 -Action SelfTest
# Entry used for the completed real test; do not repeat/reset the completed ledger:
powershell.exe -NoLogo -NoProfile -NonInteractive -File ds-bot/dev/communication/openai-vault.ps1 -Action RunFederation
```

Real `RunFederation` reuses the saved key without a prompt. The completed pilot's
ledger refuses re-entry before any further request; saving a key does not grant
unlimited future spending or reset a run. A separately requested future run can
reuse the key with its own explicit request/token/budget record. The current
price-verification date gate must be reviewed before a later-date run. The
ordinary app's personal DSH profile and live model configuration were not changed;
this entry currently integrates the isolated local DS-Bot communication test.

Deleting a local blob disables local reuse but does not revoke another copy or
the remote API key. Rotation/deletion require the corresponding explicit action.
The newly saved key remains for authorized reuse; the earlier exposed temporary
test key should be revoked by its owner.

## Save failure and verified fix

The first visible-window attempt created an empty directory but no key file.
The native PowerShell inherited an incompatible module search path and lacked
the security cmdlets used for encryption/ACL setup. Metadata inspection confirmed
the directory still inherited permissions and contained zero entries. The exact
empty owned directory was secured through the normal approved tool path.

The library now imports Windows' existing Security module by its absolute
`$PSHOME` path before any secret input. A synthetic save/decrypt/delete probe
through the same native launch mechanism in the exact destination directory
passed. The owner then entered the new key in the repaired window. Configured
status and CurrentUser decryption both passed. No partial key record was reused
or overwritten blindly. Both temporary entry windows were owned task windows;
no unrelated app or credential store was accessed.

Two automated native lifecycle cases exercise normal and intentionally broken
inherited module paths, encryption/roundtrip, absence of plaintext in the record,
protected ownership, overwrite refusal, atomic rotation, corrupted-format and
unprotected-directory refusal, and deletion. All values in those cases are
synthetic and their verified temporary directories are removed.

## Actual complete model chain

The completed real run used a fresh pair of DSH 0.2.1-rc.4 Web hosts, the
production DS-Bot plugin and production communication preset/session adapter,
durable queues, and an independent real Hub process on computer 88. The public
Human API drives the same server endpoints as the UI. The model was exactly
`gpt-6-luna` through the installed public pi-ai Responses adapter and official
SDK, then the nonce-authenticated local exit guard and official OpenAI.

Seven checks passed:

1. Human A -> Hub -> Bot B's actual DSH communication Session -> real OpenAI ->
   persisted final/export -> Hub -> Human A's canonical DM, with stable IDs.
2. A read-only Human's group publish was rejected by the server with no model call.
3. A precisely mentioned passive Bot replied once in the mixed group, with the
   original reply reference and delivery permission recorded.
4. A remote injection asking for a private DM, environment/API key and local
   commands was refused. The synthetic canary appeared only in its authorized
   DM payload, never in either group request or inspection history.
5. The B host was stopped after the real final had persisted but before export.
   Restart recovered/exported that same answer without another model request.
6. A second restart produced neither another request nor a duplicate final.
7. B's original private Chief event watermark remained unchanged.

**6 actual official requests** = three exact token-count calls plus three
generations. Usage was **6466 input / 22 output tokens**. The conservative modeled
generation-token upper estimate is **$0.0016275**, at $0.25/M input and $0.50/M
output; this is not an invoice or a final account-bill guarantee. Rates come from
[official OpenAI pricing](https://developers.openai.com/api/docs/pricing).
The request limit was eight and the modeled token-money ceiling $0.02, below the authorized
$5 account ceiling. No extra request was made to use up the budget.

This newly authorized saved-key run is separate from the earlier temporary-key
provider-only pilot (7 requests). **Cumulative official requests across the two
authorized runs: 13**, with both original ledgers retained. No counter was reset.

The real test completed before a final cleanup hardening change: owned test
hosts/mocks now exit when their dedicated supervisor disappears, and the Hub
closes on parent IPC disconnect. That hardening and the SDK assistant-phase
history handling were validated with unit tests and the final complete Mock
run; no additional real calls were spent to repeat accepted model behavior.
The final Mock also passed all seven checks with six loopback requests.

The unwanted request found during preparation came from the test's explicit
edit to the Bot's instructions: normal DS-Bot behavior sends a private profile
update notice. The strict guard blocked its broad private-chat tools before
external dispatch. The harness no longer makes that unnecessary edit and waits
for the initial Mock kickoff to settle before selecting the real route. No
communication permission was broadened and no upstream DSH source was patched.

Only the owned A/B processes, guard and Hub were stopped. Five test ports were
verified free. Profiles/queues and sanitized evidence are retained; the encrypted
credential intentionally remains. The current suite has 1491 cases: 1489 pass,
two original skips; lint and generated-bundle checks pass. The published plugin
and Hub's 94 file hashes still match the earlier final federation review.

This proves the full **same-computer backend chain** with a real model. It does
not prove different-machine networking, WSS/NAT, every model behavior or real
model-driven management tools. Earlier Chrome UI matrices remain their own
Mock-backed evidence. No real remote Bot was connected and VirtualInput was not
touched. See `openai-encrypted-chain-evidence.json` for machine-readable proof.
