# Private local input preparation

Status: **PASS_INPUT_CHANNEL_ONLY / REAL_NOT_RUN**, 2026-11-03.
The owner authorized an existing temporary key for official OpenAI only,
synthetic data, at most eight outbound requests and a $5 account spending ceiling;
the owner will revoke the key afterward. The parent did not forward its secret.
This phase was explicitly restricted to preparing input, without an API call.

## Verified on computer 88

Machine identity: `<Windows test host>`, repository `D:\git\DS-Bot-federated`.
Both native Windows PowerShell 5.1 and PowerShell 7.6.5 ran the synthetic
child-process check successfully. An interactive terminal run also exercised
`Read-Host -AsSecureString` with a synthetic value: only asterisks appeared,
the child validated its private environment and exited successfully. No real
key was used, account or API access checked, network request made or file
containing a credential created. The terminal process exited afterward.

The native command lookup returned two Node installations; the launcher now
selects the first executable instead of converting both paths into one invalid
filename. The selected Node was `D:\Program Files\nodejs\node.exe`.

## One command to verify the channel without a key

Run this on 88 in a normal terminal:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -File "D:\git\DS-Bot-federated\ds-bot\dev\communication\openai-private-input.ps1" -CheckOnly
```

Expected output: `PASS_INPUT_CHANNEL_ONLY` followed by a fixed statement that
no API request was made and the synthetic input was discarded. No administrator
privilege, execution-policy change, new account permission, persistent credential
or account login is required. The test tool itself needs its normal approval
for launching a child process; this does not grant API access.

## Hidden manual input command (rehearsal only)

```powershell
powershell.exe -NoLogo -NoProfile -File "D:\git\DS-Bot-federated\ds-bot\dev\communication\openai-private-input.ps1"
```

This displays `INPUT CHECK ONLY`, prompts for hidden input, then discards it.
**Do not ask the owner to re-enter a real key now:** this version rehearses the
channel and cannot keep a key ready for a later test or perform a real test.
The fixed real-test worker must first be connected to this same input method;
then the owner should need to enter the temporary key once for the actual run.
Do not describe successful rehearsal as an authenticated or staged connection.

The secret never enters the command string, shell history, arguments or a file.
The dedicated `-NoProfile` PowerShell process converts its SecureString only
for one child process's `ProcessStartInfo.EnvironmentVariables`, not `$env:`
or User/Machine settings. It clears inherited environment variables before
adding essential Windows/temporary-path values and the unique input reference.
It removes the reference after spawning and zero-frees the unmanaged BSTR.
The Node worker removes the reference from its own environment before validation,
does not spawn descendants or import network/DSH/file APIs, and emits only fixed
status metadata. Both processes exit. Managed runtime copies are subject to GC;
this is not a claim of forensic erasure from OS memory, swap or crash dumps.

Do not paste a key into chat, a command, `.env`, a profile, a task message or
logs; do not use `setx`, credential-save UI or a real user's DSH_HOME. The real
key must remain in the dedicated guard worker; future DSH children receive only
a distinct launch nonce. No clipboard contents or existing secret stores were read.

## Cost limit: what can be enforced

The existing exit guard transactionally reserves eight total outbound slots,
including metadata and exact counting. Each generation reserves a count and a
generation slot, with input <=12,000 and output <=1,024 tokens. Four generations
reserve at most $0.014048 in modeled generation-token charges at the verified
prices, or three generations/$0.010536 after one metadata check. This is below
the owner's $5 ceiling; the disabled template remains unchanged at zero budget.
The guard does not need to raise its selectable token-money ceiling to $5.

It **cannot strictly guarantee a final account bill <=$5**. The consulted docs
do not explicitly price the counting/metadata endpoints, and the process cannot
control other account activity, taxes or provider billing changes. Current
OpenAI organization/project settings offer **Enforce a hard limit**, but its
enforcement is not instantaneous and tracked spend can exceed the configured
amount slightly. A spend alert alone does not stop traffic.
[Official project limits](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform).
Prepaid balance exhaustion can also have delayed cutoff.
[Official prepaid billing](https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing).

No billing settings or account permissions were inspected or changed. Do not
request a broader administrative key or configure persistent credentials to
verify them. If an absolutely zero-overage $5 final-bill guarantee is mandatory,
real execution remains blocked; the parent must present this exact limitation.
No model/account permission is yet proved. Authentication or permissions errors
must stop the pilot without fallback, more requests or a wider credential scope.

The earlier [OpenAI model/budget preparation](openai-model-preparation.md) and
its evidence remain a dated snapshot. The new input tests add two cases; current
complete results are recorded in `openai-private-input-evidence.json`.
