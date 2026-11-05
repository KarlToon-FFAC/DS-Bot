# Selecting a previously joined Hub

The local status API previously returned two different shapes for the same
`onboarding-storage` request without a Hub ID: a list before configuration, but
a single record after configuration. The picker needs the list's `selectedHub`
field. Missing it hid disconnect/resume controls and made a currently selected
Hub appear selectable. That selection then omitted `expectedCurrentHubId` and
correctly failed the server's stale-selection guard. This is a reproduced local
UI contract defect; it does not prove the inaccessible external machine's exact
exception or deployed revision.

No Hub ID now always requests the overview, including selected/paused state and
saved enrollments. An explicit Hub ID still returns its one record. An older
credential provider without listing can still expose the selected saved record.
Same-Hub selection with the correct identity is an idempotent local no-op: no
key generation, proof, configuration rewrite or reconnect. A missing saved
identity returns JOIN_NOT_SUBMITTED rather than dereferencing null and producing
an unclassified failure. Concurrent selection still fails HUB_SELECTION_CHANGED.
The client clears obsolete selected state on refresh.

## Disconnect, revoke and delete are different

Current disconnect is a local pause with retained identity, scoped trust, queue,
contacts and history. Resume requires explicit confirmation and a fresh approved
status/login proof. Selection of another Hub does not delete the previous one.
This is not permanent account deletion or departure from every group.

Hub administrator revocation removes instance trust, closes authenticated
connections, removes active memberships and revokes pending deliveries. It keeps
principal/history rows for references and audit. The repaired maxPrincipals check
counts principals whose instance is currently trusted; revoked historical rows
no longer consume live quota. Re-approval of a new key gets a new identity/user
code. Administrator repair or static pairing revision increases must fit the
live quota too, preventing restored historical identities from exceeding it.
Historical retention is unchanged; there is no server history hard-delete or
automatic retention migration in this revision.

`leave-hub` uses a fresh purpose-bound signature by this exact device key to
revoke its server access and memberships. It refuses voluntary departure while
any participant on the device owns an open group: transfer or dissolve first.
An administrator can revoke an unavailable owner; its retained inactive ownership
is deliberately not reassigned. Other members do not acquire its privileges.
Only explicit administrator repair of that same device permits owner recovery.

Uncertain departure is reconciled through `hub-leave-status`, which remains
signature-protected after revocation. A verified non-revoked status after explicit
administrator repair clears the local departed fence without resuming messages.
The user still confirms resume separately; old group memberships stay removed.
Old Hubs without these proof purposes must be upgraded; authentication is never
bypassed. Existing temporary test profiles do not create real-device grants.

`forget-hub` separately confirms the exact local Hub identity, requires departure
for approved devices or cancellation for pending requests, and removes only that
Hub configuration/signing record/CA trust. Default retained history is not bound
to a fresh key; additional key-derived namespaces prevent accidental reuse.
Deleting remote message/cache files needs a second explicit boolean confirmation.
Only the validated owned queue directory or exact legacy SQLite files are removed;
linked roots/parents and stale identity or Hub selection are rejected. The active
runtime is closed before file cleanup. Failed cleanup preserves its credential
record for inspection and explicit retry. Other Hubs are not deleted or resumed.

The cleanup scope is the remote communication queue, not DSH model-session journals
or browser-local drafts. Results explicitly report that model-session history is
retained. This is not a total local erasure feature. Public credential deletion,
filesystem cleanup and configuration edits are separate operations; they cannot
be advertised as a cross-provider transaction. Identity/scope/lease checks repeat
before destructive writes, with the usual residual OS-process race between check
and filesystem operation. No real profile or database is migrated by tests.

Isolated tests cover selected/paused/restarted/legacy state, older providers,
same-Hub no-op, stale selection and missing credentials, alongside existing
A/B/A retained queues and revocation tests. Additional temporary-file tests cover
linked caches, selection/key races, credential-delete interruption and repaired
departure recovery. Actual loopback WebSocket/HTTP tests cover wrong-key/owner
denial, a committed departure whose response is lost, signed status reconciliation,
administrator authorization, quota release and capacity-checked repair. No real
Hub was changed or retried, and no physical-machine or real-model claim is made.
