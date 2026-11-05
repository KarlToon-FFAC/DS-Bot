# Contact removal and device connection recovery

## Reproduced defect

On base `d61b42a`, a real loopback Hub and two synthetic socket clients reproduce
an ordering race. Client A receives a membership snapshot, then client B commits
`contact.revoke`. Revocation changes the affected DM membership epochs. A's next
`conversation.sync` or `conversation.ack` uses the obsolete epoch and receives
`MEMBERSHIP_REVOKED`. The transport previously interpreted this conversation
permission change as a terminal connection failure, closed the socket and set
`running=false`. Refreshing the browser cannot restart this stopped host runtime.

The synthetic instances retain `trusted=1` and their exact connection epochs
throughout. Contact revocation does not call device revocation or change device
credentials. This establishes a repository defect matching the report, not the
cause of any uninspected production deployment.

## Scoped recovery

Only authorization errors from the synchronization reads and cursor acknowledgments
(`NOT_A_MEMBER`, `MEMBERSHIP_REVOKED`, `CONTACT_REQUIRED`) invalidate the current
local authorization snapshot and schedule another membership read on the same
live authenticated socket. No model processing runs from that failed poll. New
membership epochs then invalidate old inbox grants through the existing queue
reconciliation. Message and operation permission denials remain failed durable
intents; they are not endlessly retried and cannot block unrelated group work.

Actual authentication rejection, stale device connections, invalid responses and
TLS failures keep their existing behavior. This change neither repairs device
trust nor restores a revoked contact. Network reconnect still authenticates
normally. Histories, queue IDs, device keys and group permissions are preserved.

## Evidence and repeatability

- The new baseline `conversation.ack MEMBERSHIP_REVOKED` test fails against the
  original source and succeeds after the patch.
- Seven plugin regressions cover both sync/ack phases and all three scoped codes,
  authorization failing closed, no socket close, successful next poll, and a
  permanently failed outbound permission denial.
- Two real-socket Hub tests place a genuine `contact.revoke` between an already
  computed snapshot and its client receipt. Both the sync and ack paths recover
  without changing device trust or the connection epoch.
- `node ds-bot/dev/communication/contact-removal-acceptance.mjs` passes six checks
  using fresh independent real DSH hosts, a real loopback Hub and local
  deterministic Mock: Bot reply, the contact race, denied new DM with continuing
  shared-group Bot work, network reconnect, normal host restart with retained
  history, and actual device revocation remaining terminal for only that device.
  The private nonce-scoped evidence is under ignored `.dsh-test-tools/`; the script
  stops every process it owns. No real Hub, model account, user profile, Actions,
  publication or remote push is used.

Run plugin tests in `ds-bot/`, Hub tests in `communication-hub/`, plus the normal
client freshness and lint gates. The acceptance script needs the documented
plugin, Hub and DSH harness dependencies.

## Safe incident correlation

Preserve the current profile and original device identity. First distinguish
contact removal from the Hub administrator's **Remove device** action. Ask only
for the two client commits, Hub commit, event time/time zone, safe error code,
`connected`, `lastConnectedAt`, and whether the exact device is approved or revoked
on the administrator page. Public instance/request IDs can correlate records.
Do not request raw logs, cookies, authorization headers, Hub codes, private keys,
credential records or profile/database copies.

If only the contact race has stopped an old host, a normal full host restart can
recover its existing approved identity; browser refresh alone cannot. If the Hub
administrator actually revoked the device, reconnect is correctly denied. Use
the existing explicit revoked-status and original-device repair or new-enrollment
workflow. Never delete a profile, replace its key, or rejoin blindly as a generic
connection workaround. The incident's disconnect/resume error and stale page
status require their own deployment evidence and lifecycle checks.

## Follow-on administrator removal, disconnect and repair

The extended `node ds-bot/dev/communication/hub-lifecycle-acceptance.mjs` passes
seven checks against two independent real WSS Hubs, two fresh normal DSH profiles,
SDK-stored synthetic signing identities and local Mock. Its added final sequence
removes an actively connected device through the actual administrator CLI route.
The existing host observes `connected=false` and `UNAUTHENTICATED`, while the other
device remains online. Local `disconnect-hub` still succeeds without authenticating
against the revoked device. Explicit `resume-hub` is rejected and stays paused.

The original key can then prove `hub-leave-status` even while revoked. It records
`departed=true`, so blindly repeating Join is rejected as `HUB_LEFT`. The fixture
administrator deliberately repairs the exact original device revision. A fresh
signed status check clears only the departed fence, keeps the device paused and
never resumes pending work automatically. Explicit Resume reconnects the original
instance/Human identity; removed group memberships are not restored. A separate
plugin regression verifies the same sequence and that local Disconnect makes no
network request after revocation.

This confirms the backend lifecycle in the supported editable profile, including
a real administrator revocation, not browser repaint timing. The reported failure
of local Disconnect itself did not reproduce in this fixture. The runtime state
and a locally saved enrollment's historical `approved` status are distinct:
onboarding storage is not proof that the device is online or still trusted.
Page refresh/subscription improvements are handled separately. No production
administrator repair or profile/key deletion was attempted.

The first supplementary fixture run passed the revoke/disconnect/reject sequence
but failed its own final Join assertion because it incorrectly took a trust
fingerprint from `management.info()`. The corrected fixture obtains it through
`decode-hub-code`, exactly like the production client; the full rerun passes.
This fixture setup mistake is not counted as an application failure or hidden.

Final local gates on this branch: plugin 1,768 passed, four existing skips, zero
failures (1,772 total); Hub 119/119; client/office generated-file freshness and
lint passed, with existing lint warnings only. The initial full plugin run's
freshness failure was caused solely by a test dependency symlink changing esbuild
source-region comments; using a real local dependency copy restored the unchanged
committed bundle's normal freshness check. No generated application artifact was
changed to hide that environment issue. All owned acceptance ports were verified
free after shutdown.
