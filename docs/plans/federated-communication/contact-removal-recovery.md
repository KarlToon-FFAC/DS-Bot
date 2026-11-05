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
