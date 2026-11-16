# V0.4.1: diagnose and recover unavailable federation Sessions

A synchronized Hub watermark is not evidence of a model turn. In particular,
resolveAgent failure in export/ensureSession can leave inbox rows pending forever.
The remote execution Session and local Bot chat intentionally have different IDs;
never bind a remote conversation to the Bot's local chat to repair this.

Recover automatically only an exactly missing public Session (`session/not-found`)
and an entirely unused binding: all AI rows still pending/unmapped, context cursor
zero, no replies/exports/completion evidence, and all surviving Sessions idle with
no input/turn events. Recheck durable evidence in the queue transaction; preserve
the binding/recipient/epoch and audit detached missing references. Create a fresh
isolated Session through the existing preset path. Never replay unknown, injecting,
accepted or previously used work based on a missing file.

Every other failure stays explicit and retains its exact input and binding. Include
safe failure stage, Session ID, public cause code and error class in local activity
and diagnose; never include raw errors, keys, prompts or chat content. One failed
binding must not hide another binding's errors or prevent its pending delivery from
being attempted. Transport connection/synchronization state remains independent.
`invalidations` is a legacy name for Hub change hints, not connection failures.

Do not attribute generic COMMUNICATION_UNAVAILABLE in Bot DM tools to binding loss:
that code currently also wraps unrecognized host exceptions. Diagnose its own
operation stage and host cause without exposing raw exception text.

## Reproduced and verified

The fault was reproduced with the released V0.4.0 (`9350e255`) and DSH
0.2.1-rc.4 using two isolated native DSH profiles, a local Hub and mock models:
seed a current Bot membership's unused binding with an absent Session reference,
then @ that Bot. The unmodified release stores the activated input but retains
pending/applied=0 without admitting a model turn. The patched release detaches
only the proven-unused missing reference, creates an isolated execution Session,
and answers the original message exactly once. The binding survives a real Host
restart and answers the next @.

Commands (from the repository root):

```
node ds-bot/dev/communication/binding-recovery-acceptance.mjs --baseline-plugin /path/to/V0.4.0/ds-bot
node ds-bot/dev/communication/binding-recovery-acceptance.mjs
```

Both positive and negative native controls passed. A separate controlled native
0.3.9 -> 0.4.0 restart upgrade with a valid persisted binding also passed: the
regression is not universal for every upgrade. This does not establish that every
reported INJECTION_UNKNOWN has a missing-file cause. Compare the new binding stage,
Session ID and public host cause with the affected machine; do not infer absence
from a remote/local Session ID difference.

Validation: full plugin suite 2,261 tests, 2,256 passed, 5 skipped, zero failures;
an additional race guard and its focused test passed after that run. Native team
smoke passed all 52 steps. Build/generated-artifact checks and lint passed with
existing warnings. Focused coverage includes used/unknown admission refusal,
receipt/context evidence, writer/SDK failures, privacy of diagnostic metadata,
concurrent admission, another healthy binding, and shutdown admission boundaries.
No production profile, Hub database or installed DSH was modified. Windows and
real provider behavior were not exercised in this Linux environment.

The local activity view now includes safe failure stage, host code, error class
and a bounded plugin source location when available. communication_diagnose keeps
connection status separate and adds bindingFailures; error=null at the transport
level no longer hides the per-Bot execution failure. Unknown tool exceptions carry
safe hostFailure metadata instead of only COMMUNICATION_UNAVAILABLE. No raw
exception message, stack, key, prompt, local absolute path or chat content is added.

The V0.4.1 output-drain shutdown path also closes ordinary request admission
immediately; only already queued output evidence can perform required drain saves.
This preserves the named-request no-send-after-stop invariant while saving drafts.

Version remains V0.4.1. Hub protocol/schema and Bot identities are unchanged. Deploy
the plugin update and restart its DSH Host normally; no Hub or client reset is
required. Ambiguous/used missing Session history is deliberately not replayed: the
operator must restore the missing history or investigate its original admission.
