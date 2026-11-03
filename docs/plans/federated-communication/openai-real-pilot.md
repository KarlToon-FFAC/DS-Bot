# Actual OpenAI provider pilot

Status: **PASS_OPENAI_PROVIDER_PILOT**, 2026-11-03. This supersedes the earlier
input-only and NOT_RUN preparation snapshots for the narrow provider scope.
The user authorized the temporary key, official OpenAI, synthetic data, at most
eight requests and a $5 account ceiling, subsequently accepting slight overage.
No persistent credential was created. The fixed real test has already completed;
**do not run it again or request another key for this completed run**.

## Actual result

The one-time native launcher used hidden local input and a child-only environment.
The worker consumed and removed the input reference before any request. It sent
only fixed synthetic prompts/messages directly to `https://api.openai.com`, with
exact model `gpt-6-luna`, Responses, Standard tier, `store: false`, reasoning none,
text-only output, no tools and no automatic retries or redirects.

- One model visibility request confirmed the exact model ID.
- Three exact input-count requests preceded three generation requests.
- Three probes passed: synthetic DM acknowledgment, an authorized mentioned
  passive-group reply, and refusal of a remote request to reveal keys/another
  private chat or execute local commands.
- **7 total actual requests**, 2,195 generation input tokens, 29 output tokens.
  Each input remained below 12,000 and each output below 1,024 tokens.
- The conservative modeled generation-token upper estimate is **$0.00056325**,
  using $0.25/M input and $0.50/M output. This is not a billed invoice amount;
  token-count/metadata fees, taxes and unrelated account activity are outside it.
- The SQLite gate retained seven reserved slots and $0.010536 in worst-case
  reservations. The local selectable generation-token budget was only $0.02,
  below the owner's account ceiling. No remaining call was consumed needlessly.

The probes use the production `communicationPrompt` with synthetic identities;
the sender is the bounded native-fetch Responses adapter. This verifies actual
model access and these prompt behaviors. **It does not run real-model turns
through the DSH/Hub delivery/export/recovery chain**, execute communication tools,
or prove different-machine networking. Those production paths retain their
earlier local deterministic-Mock acceptance; their real-model coverage remains
unrun. Model refusal is empirical, not a replacement for server authorization.

No raw model output, request body, auth header or secret was persisted. Public
evidence contains only case status, counters and usage. The worker finished,
closed its SQLite handles and removed its owned run lock. The owned idle input
console was closed only after checking its recorded PID/start time and absence
of a model worker. Other apps, the user's original browser tab and VirtualInput
were not changed. The owner should now revoke the exposed temporary test key.

## Implemented entry and reproducible Mock

Current source is `ds-bot/dev/communication/openai-real-pilot.mjs`; the existing
native secure launcher now supports explicit mutually exclusive switches:

```powershell
# Complete workflow with an internally generated synthetic key and loopback only:
powershell.exe -NoLogo -NoProfile -NonInteractive -File "D:\git\DS-Bot-federated\ds-bot\dev\communication\openai-private-input.ps1" -Mock
# Actual entry used for the completed authorized run (do not repeat it now):
powershell.exe -NoLogo -NoProfile -File "D:\git\DS-Bot-federated\ds-bot\dev\communication\openai-private-input.ps1" -RunOnce
```

No switch defaults to real execution. Mock mode refuses credentials without the
synthetic prefix before opening any destination. Only real mode uses the native
official sender; its destination/model remain pinned. The real ledger always
uses `.dsh-test-tools/openai-authorized-pilot/budget.sqlite`; an existing nonzero
run refuses re-entry before any network call and preserves its original result.
Do not delete/reset the ledger or change the run path to bypass the eight-call
authorization. Startup locking prevents concurrent pilots. Interrupted unknown
requests retain their slots. Any auth, count, connection or reply failure stops.

Four added cases verify complete loopback flow and secret-free persisted files,
poisoned authentication error bodies, count overflow, uncertain dispatch, reply
failure/no retry, durable re-entry refusal and rejection of nonsynthetic keys
in Mock mode. The full suite is now 1487 tests, 1485 passing and two original
skips. Lint passes with existing warnings; the generated client is fresh.
The published production files remain unchanged from the final federation review.

See `openai-real-pilot-evidence.json` for sanitized real counts, source hashes,
Mock evidence and cleanup. Persistent encrypted reuse is a separate proposed
action in [the credential design](openai-credential-storage-proposal.md).
