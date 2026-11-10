# Permanent administrator device deletion

## Why the old entry left data behind

The Hub page called `revoke` under the label **Remove device**. Revocation was
intentionally reversible: it kept the instance, public key, Human/Bots, user
codes, contacts, history, operation results and inactive group ownership. It was
not deletion. That action is now labelled **Revoke access**, alongside the
separate **Delete device permanently** action.

## Exact scope and confirmation

Only the separately authenticated Hub administrator can POST `/admin/api/delete`.
A Human, group owner, group admin or Bot has no such route or implicit right.
The existing same-origin, session/CSRF or explicit admin-Bearer checks apply.
No real Hub or client data was used in implementation or verification.

The input is:

```json
{
  "instanceId": "the exact instance ID from admin state",
  "expectedPairingRevision": 1,
  "expectedNameVersion": 0,
  "ownedSharedGroups": [{ "conversationId": "group ID", "version": 3 }],
  "confirmDelete": true
}
```

Use `ownedSharedGroups: []` when state lists none. The admin state supplies each
owned shared group's ID, title and version. The page lists these exact groups in
the irreversible deletion confirmation. A changed identity/name version or group
list/version fails before deletion. Property order in JSON is immaterial.
The stdin operator CLI supports `delete` with this same input. Neither CLI
retries an uncertain mutation automatically. Inspect state before retrying.

Deletion is one SQLite transaction and removes:

- The exact instance, enrollment public-key authorization and its join requests.
- All its Human/Bot principals, display preferences/profiles, publication state,
  avatars/unfinished uploads, observed address and administrator name override.
- Its user codes, contact relationships and requests in either direction.
- Its memberships, invitations as recipient or inviter, cursors and deliveries.
- Every DM involving it, and groups with no membership from another device,
  including events, messages/inline attachments, delivery receipts, response and
  input-update records, causality state and dispatch records.
- Its own operation receipts and other operation results referring to deleted
  records, including removed invitation IDs, plus old audit entries whose subject
  is a deleted identity/request. Replaying another device's old invitation
  operation therefore cannot return a now-deleted invitation as a success.
- The exact device's contact-request rate-limit row and each deleted principal's
  contact-target rate-limit row. Shared address and global abuse limits remain.
  There is no deleted-device identity, repair record or recovery owner tombstone.

Shared groups are not erased. Others' messages and the shared canonical history
remain unchanged. If the deleted identity owns an open shared group, that exact
confirmed group is closed, pending invitations/deliveries are fenced, owner and
routing are cleared, and no other person is promoted. A revoked owner does not
block this administrator action. If another identity owns the group, only the
deleted identity's membership and any routing through its Bot are removed.
Closed shared groups retain history with no owner reference to the removed
identity. Shared historical message/event author IDs remain references in that
shared history, not authenticatable principal rows. This exception is explicit;
this operation is not a whole-Hub history wipe.

Active sockets are closed only after successful commit. All outstanding proofs
for the removed instance/key/requests are invalidated. Failed commits preserve
both data and proofs. Repeating the same valid deletion after the instance has
gone succeeds as `alreadyDeleted:true` without recreating any record. After a
restart it remains absent. The same public key can submit a fresh join, but gets
an unrelated new instance, Human, code and empty memberships, requiring ordinary
administrator approval and fresh bilateral contact consent.

A statically configured peer must first be removed from the server's `peers`
configuration and the Hub restarted. Revoking it in memory alone does not satisfy
that prerequisite: otherwise a restart could recreate it from configuration.
No configuration file or process environment is rewritten by device deletion.

## Boundary with complete test reset

Deleting a device on the Hub does not erase another computer's local databases,
DSH journals, browser drafts, credential records or shell environment variables.
Use the explicit destructive client reset to discard old Hub configuration,
identity, queue and remote sessions before requesting fresh access. Merely
reusing an old approved SDK request does not create a fresh application.

A complete test reset is different: all Hub and client federation data is to be
removed, including shared history, saved paused Hubs and keys. There is no archive
or automatic fallback. Its implementation and guide are separate. Ordinary
local disconnect/reconnect and revoke do not become destructive resets.

## Synthetic regression evidence

`communication-hub/test/delete-device.test.js` covers complete FK cleanup and
`PRAGMA foreign_key_check`, private history removal, other devices and independent
groups, preserved shared history, exact-impact confirmation, owned-group closure
without promotion, rollback, name/pairing/group races, configured static peers,
repeat deletion, real SQLite reopen, same-key fresh enrollment, unauthenticated
HTTP and ordinary signed-client denial, and actual administrator CLI/HTTP deletion
closing a live signed socket. Only ephemeral/in-memory synthetic data is used.

The DOM interaction tests in `ds-bot/test/hub-delete-ui.test.js` execute the
actual administrator script and cover unsafe names, distinct revoke/delete
actions, exact group-impact confirmation, Cancel, repeated clicks, versioned
requests, row reconciliation, unaffected devices and the final empty state.
Visual QA uses a managed static preview with synthetic state only. It must be
reported separately from DOM/unit/socket coverage. Local Chromium startup was
blocked by this execution environment’s AF_UNIX restriction; no real browser
profile or user data was used.

## Public-profile cleanup and compact UI (2026-11-10)

Deletion now also removes `principal_public_profiles` for the exact Human/Bots
before their principals. Previously those FK children could roll back the entire
transaction, making an offline/reset client appear impossible to remove.
Administrator authority does not depend on that client's retained local keys.
Devices now use compact paged rows and a Manage dialog, with separate exact-impact
confirmation. See [reset cleanup and density](hub-device-reset-and-density.md)
for real-Hub browser evidence and current validation.
