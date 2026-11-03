# Final local security review

2026-11-03. Checkout: `D:\git\DS-Bot-federated`, implementation branch
`chore/federated-communication`. The requested `docs/federated-communication`
baseline remains `6ede702b7d698a8d86261ecb6a2a5f1efc8e1e87`. All implementation
changes are uncommitted; nothing was pushed, published or deployed.

This record supersedes earlier partial/blocking snapshots and their test counts.
The original P0–P4 gates were completed before the added governance work.
Independent read-only Hub, adapter and evidence reviews then found issues that
were fixed before this final regression. No upstream DSH code was changed.

## Findings and resulting behavior

| Finding | Fix and verification |
|---|---|
| A removed/rejoined Bot Session could borrow a newer membership epoch | Every bound tool freshly authorizes the exact binding; new outbox messages and management intents capture their epoch. Hub validates it transactionally. An uncertain retry preserves its original scope. Missing legacy scope fails explicitly. |
| An empty cwd did not remove inherited or durable private instructions | New Sessions use an owned persona-only public Preset and verify its active composition. Prompt/tool allowlists and pre-step input checks prevent inherited filesystem instructions and unknown requests from entering the model. Only DSH's required isolated-cwd snapshot is permitted as operational context. |
| A completed final could borrow a previous turn's response grant | Final extraction requires canonical communication/recovery requests from the same turn; export verifies the exact local AI delivery, conversation, recipient and epoch. Unsourced/mixed/cross-turn requests fail closed. |
| Legacy Sessions could retain previously admitted private context | Fully settled, already-exported old segments remain readable and rotate to a fresh isolated Session. Pending, interrupted or unexported old work is quarantined as `COMMUNICATION_SESSION_MIGRATION_REQUIRED`; it is not copied or resumed automatically. |
| Bot final publication failures were hidden | Permanently rejected final outbox records remain stable and are shown to authorized Humans in the selected conversation, including the original reply message ID and failure code. They are not regenerated. |
| Removing an unaccepted/inactive invitee left a usable invite | Removal revokes pending invitations transactionally and records an actual change. |
| A publish could be accepted but exceed a complete downstream response envelope | Full event/delivery containers and response metadata are budgeted before acceptance. Pathologically padded dates, malformed Unicode identifiers and control-event ID collisions fail before commit. |
| An absent owner could lose the last capacity slot | Acceptance reserves the retained owner's slot; reclaim also enforces capacity. Only that exact owner can reclaim, and closed groups remain closed. |
| Repeated acceptance runs accumulated bounded membership history | `DSBOT_TEST_RUN_ID` creates fresh named test profiles/Hub databases while retaining old evidence; it does not reset production data. |

Unknown input is rejected before downstream middleware can consume it. A source
validation failure does not cause a tight automatic re-injection loop. Public
Session inspection and durable exact-source reconciliation remain the recovery
authority; a transport acceptance receipt never means an external business side
effect occurred exactly once.

## Final evidence

| Check | Result |
|---|---|
| Complete plugin unit/regression suite | 1469 tests: 1467 passed, 2 original skips, 0 failed |
| New communication unit cases | 35 across seven new files; includes 8 final security regressions; one additional local-prompt regression is separate |
| Independent Hub suite | 31/31, including 5 final security cases and exact-full response boundaries |
| Real DSH + deterministic Mock governance/privacy | 9/9, including three private canary locations, rejected-final diagnostics and zero model calls for an unsourced local input |
| Native P4 recovery/network/behavior/atomic matrices | 7/8/11/2 cases passed; recovery rerun after the final pre-step change |
| Original real-host smoke | All 52 original steps passed; regression coverage, not proof of the new feature |
| Build freshness, lint, whitespace check | Passed; lint retains existing repository warnings, no errors |
| Clean package installation | Plugin 87 files and Hub 7 files; all installed file hashes equal source; full pinned DSH consumer imports and in-memory loopback Hub health/start/close passed |

Machine-readable final results: [final-review-evidence.json](final-review-evidence.json).
Raw logs and package verification are retained under repository-root
`.dsh-test-tools/review-*.log` and `pack-review-final/verification.json`; they are
excluded from the package and Git. Earlier unsuccessful review attempts are
diagnostic history and are not counted as passes.

The final native governance run uses `governance2-review8-a/b`, recovery uses
`p4-review8-a/b`, and the completed network/behavior runs used fresh review
profiles. All model work was synthetic and local Mock; independent processes on
one machine are not a real different-machine test.

A second read-only pass also caught and fixed the recovery helper re-scanning
settled legacy segments, a missing preset check on an already running bound tool
call, and exact-full envelope pagination counting a nonexistent first comma.
Sync preflight now reserves the longest future watermark. Focused regression
tests passed before the final full and native reruns.

## Browser evidence and limits

Real authenticated Chrome tabs at loopback 3107/3108 showed the actual production
UI. Verified: transferred owner versus former-owner admin controls; last-owner
leave protection; Human read-only composer; saving speak then restoring read-only
through the UI; permanent Bot-final failure with its stable ID. The final Chrome
viewport capability successfully applied 508/700/1024×760 sizes. At each size the
document and communication frame width matched the viewport and the main pane
had no horizontal overflow. Screenshots were captured and inspected in the task
tool record; no standalone screenshot/trace files were exported, so an offline
reviewer cannot reconstruct those interactions solely from repository files.
These final direct viewports supplement the earlier same-origin iframe matrix.

The viewport override was reset. Only the two new task test tabs were closed;
the original user page was left alone. Test processes and known test ports were
checked after shutdown, with data retained. VirtualInput was not touched.

Supported validation scope: native Windows, Node 24.13.0, DSH 0.2.1-rc.4,
DS-Bot 0.2.6, Hub 0.1.0, loopback WS. Different IPs, WSS runtime, NAT/public
deployment, other operating systems and real-model semantics remain NOT_RUN.
An isolated Preset is not a sandbox against arbitrary trusted in-process plugins;
custom Host compositions need their own review. Legacy unfinished work requires
an explicit operator decision before reuse.

## Run independently

Use the [native runbook](../../../ds-bot/dev/communication/README.md), with a fresh
`DSBOT_TEST_RUN_ID`, to run the local matrices. Use the [production adapter
configuration](production-adapter.md) and [Hub run/stop instructions](../../../communication-hub/README.md)
for an owner-configured instance; communication is disabled by default. Stable
instance IDs must match pairing before first startup. No persistent service,
credential or firewall change is installed by the benches.

The requested real-model attempt is prepared separately in
[real-model-test-plan.md](real-model-test-plan.md). No real-model call has run.
