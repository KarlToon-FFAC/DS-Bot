# Administrator-managed instance names

The Remote communication sidebar has no permanent Hub management link. Its
Personal settings gear contains the enabled, Hub-advertised management URL, or an
explanation if management is disabled. Setup and contact dialogs may retain
contextual access; no address is guessed from a WebSocket URL.

Hub administrators may change the display name of a known static or enrolled
instance under Devices on `/admin/`. Group owner/admin status and instance pairing
credentials do not grant this authority. Use the existing same-origin admin
session/CSRF or authenticated admin CLI, with no model tool or WebSocket mutation.
The new rename route validates an exact input shape, bounded nonempty name and
optimistic name version. Competing edits fail rather than silently overwriting.

An additive `hub_instance_names` table retains an administrator override and
monotonic name version. The canonical `instances.label` is updated atomically so
existing contact/member projections see the change. Static connection labels and
future pairing revisions cannot overwrite the explicit administrator override.
Existing databases with no override keep their original behavior. Identity,
credentials, pairing revision, connection epoch, user code, group roles, membership
epochs and message/history bodies are unchanged. Revoked instances may be renamed
but remain revoked. The audit stores the action and instance ID, not credentials.

Connected clients receive the new label through their normal authenticated
contacts poll; group-scoped members refresh within the existing five-second
metadata interval even when no contact relationship permits a directory entry.
This does not widen contact discovery. Disconnected clients update after reconnect.
The UI treats names as text, and includes the immutable instance ID to distinguish
equal labels. The CLI adds `rename` with `{instanceId,label,expectedNameVersion}`.

Acceptance must cover admin GUI save, unauthorized/cross-origin/CSRF-denied edits,
invalid shapes/names, stale version conflicts, persistence after Hub restart,
legacy and enrolled reconnect behavior, unchanged identity/history/permissions,
and online client directory/member labels. Tests use disposable same-machine
loopback Hub/DSH/Mock fixtures; physical cross-machine deployment is not implied.

## Recorded acceptance

- Hub: 88/88 tests pass, including four new instance-name cases (validation,
  competing edits, session/CSRF/Bearer enforcement and actual WebSocket role
  rejection). Existing enrolled-login persistence additionally checks renamed
  labels after reopening SQLite. Static reconnect/pairing-revision tests retain
  canonical identities, memberships and message/history bodies.
- Plugin: 1623 passed, 2 existing skips; client freshness and lint passed, with
  existing warnings. Added assertions prove renamed instance metadata refreshes
  cached group members and no admin entry exists in the permanent sidebar.
- Actual DSH A/B + real loopback Hub + local deterministic Mock:
  `instance-names-457d9b02-acceptance.json` passes three cases: unauthorized rename
  denial, online contact/member synchronization with unchanged history/rights,
  and persisted Hub restart plus static client reconnect. All five owned ports
  are free, both nonce profiles deleted, and cleanup is confirmed.
- Actual browser: `instance-names-gui/browser-evidence.json` passes seven checks.
  The admin page saves `GUI office 457d9b02`; a stale form explicitly fails and
  retains its draft. The client contact selector and existing group member
  metadata show that same GUI-saved name. The sidebar contains zero admin links;
  the Personal settings popup uses the actual advertised `/admin/` URL. Sign-out
  returns to the login-only page, both test tabs close, and owned Hub/DSH processes
  stop. Screenshots: `admin-renamed.jpg`, `conflict-preserves-draft.jpg` and
  `client-contact-name.jpg` under ignored `.dsh-test-tools/instance-names-gui`.

Run `node ds-bot/dev/communication/instance-name-acceptance.mjs` from the repository
root. Optional `--live-for-browser` provides a sanitized ready/stop file for at
most 12 minutes. This is same-machine synthetic validation, not physical
cross-machine, real-model or production credential verification. No real services,
credentials or firewall rules were changed. No live session or real credential is published. The fixture deliberately uses
a public synthetic password for disposable loopback data. Logs, screenshots,
databases and test profiles remain ignored.
