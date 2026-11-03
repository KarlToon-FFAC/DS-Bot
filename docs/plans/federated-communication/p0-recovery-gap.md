# P0: pending followup recovery through public APIs

Status: **PASS for the recorded pending-input crash case**, on pinned DSH
`0.2.1-rc.4`, native Windows / Node `24.13.0`, actual DSH Web and loopback Mock.
The earlier BLOCKED conclusion is superseded by the lifecycle-notice test below.
The separate real-browser gate remains unverified; this is not an overall P0 pass.

The implementation branch is `chore/federated-communication`; the requested
`docs/federated-communication` baseline remains unchanged at
`6ede702b7d698a8d86261ecb6a2a5f1efc8e1e87`.

## Reproduction and resolution

From `ds-bot/`, with the pinned harness installed and B stopped:

```powershell
node dev/communication/queued-recovery.mjs
```

1. Send an ordinary followup and hold its turn in the awaited public
   `agent/turn-stopping` hook after its final response has persisted.
2. Send another ordinary followup, flush, and prove its exact source identity is
   queued. Force-stop B and restart with its original isolated data.
3. Acquire the public Session writer with `resolveAgent`, flush and inspect the
   repaired log. The restored Agent is idle and the second input is pending.
4. Preserve the negative baseline: retrying that identified pending message is
   rejected as a duplicate; QueueDock's steer operation returns
   `session/steer-unavailable` on the idle Agent. Neither consumes the input.
5. Call `resumePendingInput`. It rechecks the idle writer and exact pending ID,
   then calls public `agent.steer` with a truthful host-restart notice. The
   notice has its own ID, `ds-bot-communication-recovery` producer source,
   `form: notice`, conversation and `forDeliveryId` reference. It does not claim
   to be another Human/Bot message or reuse the network delivery identity.
6. The normal Agent driver batches that notice with the original pending input.
   Public inspection proves the **same DSH input ID** is admitted. There is one
   additional Mock model call and one final output. Repeated recovery and another
   process restart add no model calls or notices for that admitted input.

The production helper is `ds-bot/src/host/federation/session-journal.js`; the
probe calls it directly. No original input is removed, reinserted or re-authored.
No empty/fabricated Human wake, private driver method, direct log edit, dependency
upgrade or DSH patch is involved. Existing DS-Bot restart delivery already uses
truthful lifecycle notices (`src/host/resume.js`). The framework's `role: user`
for an external notice does not designate a Human principal; producer source
remains explicit. Future startup integration must serialize recovery, validate
membership/recipient first and retain the original delivery mapping.

Raw synthetic evidence is retained in ignored
`.dsh-test-tools/p0-queued-recovery.json`; the sanitized current summary is
`p0-followup-evidence.json`. Mock verifies durable identity and model-call count,
not a real model's interpretation of the notice. Crash windows around the future
communication database/outbox still require P1/P2/P4 tests.

## API review correction

Public `send(message, target, wakeup)` exists in both pinned rc.4 and rc.5.
The earlier claim that rc.5 introduced it was incorrect. It appends before
waking, so it is not wake-only, but wake-only is unnecessary for the verified
truthful lifecycle-notice path. rc.5 tarballs were only read, never installed or
runtime-tested. The project remains on rc.4.

## Recovery policy and remaining gate

An active call or unavailable writer remains `injection_unknown`: no blind
replay. A claimed-but-unadmitted input may be retried only after exclusive idle
writer acquisition and a completely repaired, closed log prove non-admission.
A persisted final `stop` output can be recovered by stable source identity when
`turn/end` was lost; interrupted drafts and an earlier response followed by a
later step are excluded. Output mapping/outbox/cursor atomicity is not yet built.

Explicit protocol, authorization or unsupported-content failures can be visible
terminal failures. A normally accepted input surviving a host restart cannot be
relabeled failed, left permanently unknown or delegated to user resend to pass
the plan's no-message-loss acceptance.

Actual browser focus, navigation, switching, refresh and hidden-composer Enter
checks remain unverified. This needs the isolated local DSH browser session,
not GitHub, a real DeepSeek account or a model key. A prior secure panel-open
request returned `queued` because this delegated task was hidden; it did not
execute DSH login. See `p0-login-review.md` for the exact boundary and procedure.
