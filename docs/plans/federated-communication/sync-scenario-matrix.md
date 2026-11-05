# Isolated IM synchronization scenario matrix

## Scope and result vocabulary

This matrix fixes its code baseline at `69264f6` plus the test-only changes in
this branch. Run date: 2026-11-05 UTC. Every service is owned by an isolated
fixture. The Hub binds loopback; DSH uses fresh `.dsh-test-*` profiles and the
deterministic local Mock. No production Hub, real model, user profile, deployment,
GitHub Actions, or push is part of these checks.

- **PASS (this run)** means the named command and its assertions passed here.
- **SOURCE ONLY** means a runnable check exists but this matrix has not executed
  it. It is not a claim of passing behavior.
- **PARALLEL BRANCH** names work not present in this fixed baseline. Its results
  must be rerun after integration.
- **NOT RUN** is an explicit remaining gap.

Unit/socket checks cannot prove rendered UI behavior. Same-machine processes
cannot prove physical cross-machine routing. A fixture's admin approval is not
evidence of production approval or publication.

## Commands

Run at the repository root after the documented dependency setup:

```sh
node --test communication-hub/test/contact-recovery-matrix.test.js
node --test communication-hub/test/*.test.js
cd ds-bot
npm test
node scripts/build-client.mjs --check
npm run lint
```

The process matrices use fixed ports and must run serially. Use a new run ID for
each fresh topology. Do not reset a prior ledger or reuse a real user's profile.
These Bash commands keep the invoking shell as the bench owner until the test
returns. Do not launch process matrices with inherited Node `--input-type`
flags: `child_process.fork` propagates those flags to file-based fixtures.

```sh
DSBOT_TEST_RUN_ID=sync-20261105-0906 DSBOT_COMMUNICATION_OWNER_PID=$$ \
  node ds-bot/dev/communication/network-matrix.mjs
DSBOT_TEST_RUN_ID=sync-20261105-0906 DSBOT_COMMUNICATION_OWNER_PID=$$ \
  node ds-bot/dev/communication/recovery-matrix.mjs
DSBOT_TEST_RUN_ID=sync-20261105-0906 DSBOT_COMMUNICATION_OWNER_PID=$$ \
  node ds-bot/dev/communication/behavior-matrix.mjs
```

Network uses Web 3105/3106, Mock 8805/8806 and Hub 3193. Recovery/behavior share
Web 3103/3104, Mock 8803/8804 and Hub 3192 and retain one common run's state.
Each script stops its owned processes in `finally`. They retain isolated data
for diagnosis, not for use as a live account. Do not publish profile contents.

## Newly executed response-loss matrix

Source: `communication-hub/test/contact-recovery-matrix.test.js`.

| Mutation already committed | Lost-response injection | Expected canonical result | Status |
| --- | --- | --- | --- |
| `contact.request` | terminate socket before success response | exactly one pending request and operation result | PASS (this run) |
| `contact.request` | suppress response with socket still open until RPC timeout | same result, original socket remains connected | PASS (this run) |
| `contact.accept` | terminate socket before success response | one accepted request, one consent transition | PASS (this run) |
| `contact.accept` | suppress response with socket still open until RPC timeout | same accepted result with no optimistic local success | PASS (this run) |
| `contact.revoke` | terminate socket before success response | one inactive relation, one DM fencing event | PASS (this run) |
| `contact.revoke` | suppress response with socket still open until RPC timeout | same revocation; no device revocation | PASS (this run) |

The fault is `startHub.beforeResponse`, after the mutation transaction returns
its committed result and before `socket.send`. The timeout variant returns
`false` without closing the socket. The close variant terminates that exact
socket. Neither variant simulates success merely by returning a canned result.
An exact operation retry deliberately returns its original ACK, even if the
canonical request/relation has since advanced. Clients must reread the current
authorized snapshot rather than overwrite it with an old pending/accepted ACK.

Every row also performs these assertions:

1. Reopen the file-backed Hub and both local SQLite queues twice. On each
   restart resend the **identical** operation three times with the same signed
   device identity. Every ACK equals the committed original result.
2. Compare complete ordered rows of `hub_contacts`, `hub_contact_requests`,
   `hub_management_operations`, `conversations`, `memberships`, `events`,
   `messages`, and `deliveries` before and after replay. They must not change.
   This catches extra relationship versions, membership epochs, events, requests,
   messages or deliveries that an ACK-only assertion would miss.
3. A changed payload with the same operation ID must fail
   `OPERATION_ID_CONFLICT`. Then advance consent using **new** operations, and
   replay the old operation once more. The new relation and complete durable
   snapshot remain unchanged. An old revoke ACK cannot revoke a new consent;
   an old accept/request ACK cannot restore an older scope.
4. An already committed DM message returns its original ACK after consent
   changes. A different queued message carrying the old membership epoch fails
   `MEMBERSHIP_REVOKED`, is `failed` in the local outbox, remains failed after a third Hub/queue
   reopen, and has zero
   Hub message rows. A previously pending AI delivery stays revoked and is never
   AI-admitted by the fixture. Explicit stale `aiAccepted` and `aiStarted`
   receipts are rejected. No model is invoked by this socket matrix.
5. Human and Bot names deliberately collide. Enrolled instance IDs, Human/Bot
   principal rows, local principal mappings, trust and pairing revisions remain
   identical. Reconnection epochs may legitimately advance and are not identity.
6. A separate shared group's complete membership rows and epochs stay identical
   across contact changes and queue failure. Both queues remain authorized,
   both transports connected, and a new group message is stored and visible in
   the remote Human's synchronized local event view.
7. DM event sequence numbers remain contiguous and ordered; the original
   message occurs once. `conversation.contactChanged` occurs once per actual
   revocation and never because of retry.

## Existing executable coverage and integration dependencies

| Scenario | Executable proof / required observation | This matrix's status |
| --- | --- | --- |
| Duplicate same-direction and crossed requests; concurrent accepts; cancel versus accept | `communication-hub/test/management-integration.test.js`: one winning terminal decision, losing CAS conflict, exactly one accepted request, competing requests cancelled | PASS (Hub suite, this run) |
| Cancel unknown or privately rejected request without leaking rejection | `communication-hub/test/management.test.js`: outgoing status/version/quotas remain indistinguishable, cancelled state terminal, forged actors denied | PASS (Hub suite, this run) |
| Lost cancellation response then restart | `communication-hub/test/management-integration.test.js`: original operation result recovered, no phantom pending records | PASS (Hub suite, this run) |
| Explicit publication, scope choice and unauthorized DM/invite | `management*.test.js`, `publication.test.js`: exact principal scope; rejected operations leave no authorization | PASS (Hub suite, this run) |
| Unilateral remove/leave/rejoin; old grants denied | `governance.test.js`, `store.test.js`: current epoch required, fresh join boundary, old deliveries revoked, unrelated membership unchanged | PASS (Hub suite, this run) |
| Message ACK loss, committed Hub death, receipt ACK loss, duplicate publish | `network.test.js`: real independent SQLite processes; one canonical message/delivery and stable original acceptance | PASS (Hub suite, this run) |
| Duplicate and reordered event pages, permanent history gap | `store.test.js`: cursor cannot advance across gap, no AI consumption before missing sequence, durable buffering | PASS (Hub suite, this run) |
| WSS trust/authentication and spoofed identities | `wss.test.js`, `security.test.js`, `remote-directory.test.js`: trusted certificate works; untrusted/hostname-invalid TLS and foreign actors denied | PASS (Hub suite, this run) |
| Real DSH receive/injection/export crash windows, seven checkpoints | `ds-bot/dev/communication/recovery-matrix.mjs`: durable mappings and one reply after restart; no duplicate model admission | PASS (this run: seven real-DSH checkpoints) |
| Real DSH network windows, eight cases | `ds-bot/dev/communication/network-matrix.mjs`: before/after commit death, open-socket ACK loss, offline host restart, duplicate retry, repeated reconnect, gap repair, all-party backlog recovery | PASS (this run: eight real-DSH cases) |
| Four DM directions, same-name Bot identities, private isolation, mixed groups and member rejoin | `ds-bot/dev/communication/behavior-matrix.mjs`: exact authors, original IDs, no unrelated private prompt/history, fresh rejoin epochs | FAIL (three cases passed; reverse Bot DM failed; seven later cases NOT RUN) |
| Contact revoke races old membership snapshot or sync/ack | `fix/contact-removal-disconnect`: `contact-removal-acceptance.mjs`, `communication-membership-race.test.js`, `contact-race.test.js`; relation change must not revoke device transport | PARALLEL BRANCH; merge and rerun |
| Stop during credential/socket creation; old callbacks after reconnect; hint burst coalescing | `fix/connection-reliability`: `communication-connection-lifecycle.test.js` and Hub hint tests; no zombie socket/loop, one pump at a time | PARALLEL BRANCH; merge and rerun |
| New and old clients, missed hint, reconnect compensation and polling fallback | `fix/connection-reliability`: hints are invalidation only, current authenticated snapshot remains authority, legacy polling continues | PARALLEL BRANCH; merge and rerun |
| Rendered client pending→accepted/cancelled and remote contact removal without manual refresh | `fix/realtime-management-status`: focus/visibility/online refresh, stale result suppression and editable selection preservation | PARALLEL BRANCH; browser acceptance still required |
| Admin second tab approve/revoke/rename; logout/expiry during pending long poll | `fix/realtime-management-status`: current snapshot, authenticated waiter, no stale response after logout | PARALLEL BRANCH; merge and browser acceptance required |

## Observed baseline failure: fresh reverse Bot DM suppressed

`behavior-matrix.mjs` passed `DM-01-05-09`, `DM-02-05` and `DM-03-05`,
then failed at line 37 waiting for the reverse `K to J reply`. Seven subsequent
cases never ran. This failure does not invalidate the separate eight-case
network run or seven-checkpoint recovery run, which each reached PASS.

The reverse message was durably accepted once, but its canonical event records
`dispatchSuppressed: "DUPLICATE_HANDOFF"`; both recipient delivery rows have
`ai=0`, `stored=1`, `ai_accepted=0`. This is not a lost model output. The new local
Human instruction `COMM-SEND <J principal> K-J-<nonce>` had a new message ID but
no `causationDeliveryId`, `responseToDeliveryId` or `replyToMessageId` and an empty
activation list. `HubStore.publish` inferred the Bot-only DM genesis root and
its latest incoming parent. The prior K reply had already consumed the same
`bot_dispatches(cause_key, author_id, target_id)` triple, so the new independent
local intent was suppressed as a duplicate.

The evidence's synthetic message ID, conversation ID, parent ID and delivery
flags are retained in `sync-scenario-evidence.json`. The original isolated
behavior ledger remains FAIL. A successful fix must distinguish a genuinely
new verified local Human intent from another remote continuation. Blindly
allocating a fresh root to every uncased Bot message would bypass the bounded
collaboration safety rule and is not an acceptable test workaround.

Before rerunning, this branch also updates old behavior assertions to inspect
structured API error codes, and correctly distinguishes `INVALID_ATTACHMENT`
for malformed attachments from `UNSUPPORTED_CONTENT` for the obsolete `files`
field. These assertion updates are not execution evidence for the seven cases
that the earlier failure prevented from running.

## Remaining gaps and stopping criteria

The later focused recovery-RPC run is recorded separately in
[`recovery-prompt-rpc-evidence.json`](recovery-prompt-rpc-evidence.json), against
head `233a01f8` and tree `c1610bad`. Its five cases passed: two consecutive exact
pre-model prompt RPC losses followed by one final response, plus revocation,
new-epoch isolation with a positive control, explicit user cancellation and a
real local Mock provider error. Each safety case included two network reconnects
and a normal host restart. The original failed single-loss baseline remains in
[`recovery-prompt-rpc-baseline-evidence.json`](recovery-prompt-rpc-baseline-evidence.json).
This later focused result does not change the historical `69264f6` behavior
failure above or certify every other row against that newer integration.

The new RPC retry proof remains process-local: another host loss after a failed
pre-model guard but before successful continuation is conservatively not retried.
That combined liveness window was not asserted as passing.

- **NOT RUN:** admin revoke → signed leave-status reconciliation → forget Hub
  with `deleteLocalHistory:false` → join the same Hub with a new approval/key.
  Must prove a new instance, principal and queue namespace, no inherited group
  rights or old queued send, and old history files retained. This differs from
  explicit same-key repair and from switching between two different Hubs.
- **NOT RUN:** visible UI state on both clients throughout cancellation,
  acceptance and unilateral removal, including an open modal and unsaved Bot
  scope selection. API convergence alone is not a UI pass. A private rejection
  intentionally remains pending to the sender; the UI must preserve that rule.
- **NOT RUN:** all six new response-loss cases against the final combined
  lifecycle/hint/UI branch. This fixed-baseline run cannot certify changes that
  have not been integrated.
- **NOT RUN:** physical multi-machine network, native packaged Electron UI,
  real provider/model behavior, production Hub access and publication. These
  are outside this isolated Mock verification and must not be inferred from it.

Completion for an integrated result requires the exact final SHA, clean focused
and aggregate checks, the applicable real-DSH matrices, and explicit evidence for
the rendered UI cases. Pending or unavailable stages stay named, not converted
to pass by association with another suite.
