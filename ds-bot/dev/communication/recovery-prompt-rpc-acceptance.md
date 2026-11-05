# Recovery prompt authorization RPC loss

This is an additional real DSH A/B + loopback Hub + deterministic Mock case,
separate from the seven original host-recovery windows. It is test-only and
does not patch DSH, contact production services, or use real model credentials.

Run from the repository root, after dependency setup. Coordinate the heavy
window with other test owners; do not start a second topology concurrently.

```sh
DSBOT_COMMUNICATION_OWNER_PID=$$ node ds-bot/dev/communication/recovery-prompt-rpc-acceptance.mjs
# For the first baseline reproduction only:
DSBOT_COMMUNICATION_OWNER_PID=$$ node ds-bot/dev/communication/recovery-prompt-rpc-acceptance.mjs --case=reconnect
```

The fixture uses fresh profiles, Web 3271/3272, Mock 8971/8972 and Hub 3273.
Every wait is bounded and fixture-owned processes stop in `finally`. Results
remain in `.dsh-test-tools/recovery-rpc-<nonce>-acceptance.json`. A failed case
stays failed; later cases have their own independent conversation and input.

## Exact fault window

1. Admit one original input, hold the production `after-injection` checkpoint,
   and observe one Mock request in flight with no completed export.
2. Stop and restart only that isolated recipient. The public Session journal
   must report an interrupted original turn, never user cancellation.
3. The test probe observes `session/event` for the actual host recovery notice
   inbox splice. It records only synthetic notice/session/input identities.
4. A public, prepended `system-prompt/assemble` observer marks that exact
   Session's assembly interval. Its `finally` closes the interval, so subsequent
   routine membership polling cannot select the same fault.
5. The Hub was pre-armed for `conversation.members`, but suppresses the response
   only while the assembly interval is open and the principal, conversation,
   original delivery/message and recovery notice match. The checkpoint proves
   socket OPEN and response not sent. The Session journal backs the notice ID
   and sequence, and the Mock log proves no second model request yet occurred.
6. An IPC command terminates that exact held socket. The reconnect case repeats
   this exact sequence for a second distinct notice before allowing recovery. There is no sleep-based
   guess at the failing interval and no synthetic successful response.

## Assertions

- `reconnect`: authorized automatic recovery must remain available after this
  pre-model RPC failure. There is one original input and delivery, unchanged
  instance/principal/membership epoch, one final canonical message and export,
  and only two model requests total: the lost original attempt and successful
  continuation. Another host restart and socket loss preserve the final ID and
  do not re-admit input or regenerate the reply.
- `revoked`: while the RPC is held, remove the recipient. The original delivery
  projection becomes revoked, makes no additional model request, produces no
  recovered final/export, and stays denied
  across two further explicit reconnects and a normal host restart.
- `new-epoch`: remove and explicitly accept a new invitation through the
  canonical Hub store API under the current synthetic recipient authorization.
  This test-only IPC operation does not modify Session state or bypass product
  authorization. A new membership epoch cannot revive the old delivery/input.
  A fresh current-epoch input must still receive exactly one response without
  reusing the old Session, so a disabled recipient is not a false positive.
- `user-cancel`: while the recovery prompt RPC is held, call the documented
  `agent.cancel({kind:'user'})`, then drop the socket. The actual terminal journal
  must show cancellation/abort; reconnect and a normal host restart cannot turn it into a transport retry.
- `model-error`: a separate real Mock provider request for the explicit test command
  `COMM-MODEL-ERROR` returns an HTTP error. Its error turn must not be retried
  by transport recovery or a normal host restart.

Preparation checks cover marker matching, source attribution and assembly
interval closure. They are not evidence that these real DSH cases passed.
The first committed version of these fixtures is intentionally prepared before
the coordinated heavy run and before any necessary core repair.

## Executed result, 2026-11-05 UTC

The complete five-case run passed against this exact frozen integration:

- Head: `233a01f8e17fe44a38b7b0110869e6ce3743a0b1`
- Tree: `c1610bad85c3d3f906d0aff00f48a457733f8bfc`
- Run ID: `rpc-final-1793875813`
- Exit code: 0. Tracked source was unchanged before and after execution.

| Case | Actual result |
| --- | --- |
| `reconnect` | Two distinct notice IDs each reached the exact assembling/held/open-socket RPC window. After both losses, one original input produced one final ID. There were two model requests total, including the original interrupted attempt. A successful continuation's final ID survived normal host restart and another socket loss without regeneration. |
| `revoked` | One original input and one interrupted model request; no recovered final or old-scope export. Two network reconnects and one normal host restart did not revive it. |
| `new-epoch` | Old input/Session stayed fenced through network and cold recovery. A separate new input under the new active epoch received exactly one response. |
| `user-cancel` | Public `agent.cancel({kind:'user'})` produced an actual aborted recovery turn. Two network reconnects and a normal host restart did not revive it or add model requests/exports. |
| `model-error` | The real DSH journal contains `request/header` sequence 11. The actual Session header identifies exactly one local Mock provider HTTP 400 request. Reconnects and normal host restart added no request or export, and no Bot message reached the Hub. |

The original single-loss baseline failed and remains preserved in
[`recovery-prompt-rpc-baseline-evidence.json`](../../../docs/plans/federated-communication/recovery-prompt-rpc-baseline-evidence.json).
It was not overwritten or relabeled. The passing run has a different fresh
profile/run ID and includes the narrow core repair originating at `55f134c`.

The deliverable
[`recovery-prompt-rpc-evidence.json`](../../../docs/plans/federated-communication/recovery-prompt-rpc-evidence.json)
retains exact notice/input/delivery/epoch/final identities, journal terminal
kinds, raw-ledger SHA-256 values and post-run read-only SQLite verification.
That verification independently matched the queue instance/principal mappings
to canonical Hub principal rows and checked old-scope exports and current epochs.

All owned processes stopped in `finally`. Ports 3271, 3272, 3273, 8971 and 8972
were individually bound and released afterward to verify cleanup.

These are same-machine Mock results, not physical cross-machine, native packaged
Electron UI or real-model acceptance. No production Hub, push, deployment or
GitHub Actions was exercised. The raw fixture's `baseline` string describes its
historical base (`da47b17`); the verified head/tree above identify the code that
actually ran.

The retry proof is deliberately process-local. A second host loss after a
failed authorization guard but before successful continuation loses that proof
and remains conservatively non-retryable. This run does not claim liveness for
that combined window, or unbounded time/all possible fault combinations.
