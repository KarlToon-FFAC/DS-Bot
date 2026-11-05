# Conversation list and permission acceptance

Run `node ds-bot/dev/communication/conversation-list-acceptance.mjs` only after
the source is frozen. Fresh DSH A/B use deterministic local Mock models and a real
same-machine loopback Hub. Exclusive ports are 3211/3212 (web), 8891/8892 (Mock)
and 3213 (Hub); occupied ports stop the run without killing their owners.

The acceptance checks authorized group and DM `lastMessage` projections, current
sender names and avatars, unread/read behavior, empty and unauthorized history,
and Unicode summary bounds. It keeps a deliberate member `FORBIDDEN` management
operation in the Human outbox audit, while owner/admin management still succeeds
and readOnly speaking remains forbidden. Another conversation must remain usable.
Queued intents and same-ID retries must preserve canonical message uniqueness.
Rejections must not become chat messages. Visual placement, stacked group avatars,
DM headers, blue dots and removal of the bottom console need separate Cua evidence.

Previous acceptance scripts intentionally generated rejected settings operations:
`reply-settings-acceptance.mjs` uses `forbidden partial`, and
`hub-onboarding-acceptance.mjs` uses `must not change`. A persisted rejection from
those tests is expected audit history. Without matching an operation ID, this does
not prove that an arbitrary screenshot depicts one of those particular requests.

Add `--live-for-browser` to keep the successful fixture for at most twelve minutes
from readiness. The safe ready file contains public profile URLs, principal and
conversation IDs, the deliberate failure ID, expiry and stop-file path. It excludes
login URLs, cookies and credentials. No OS browser is opened. Create the stop file
to end early. Finally, only owned processes are stopped, all five ports are checked
free, and exact nonce profile directories are deleted. Sanitized evidence and the
test Hub database remain under `.dsh-test-tools`. No external network, real model,
real credentials, user profiles, SSH, VirtualInput or private DSH API is used.

Recorded real validation: `conversation-list-c2ea4a00-acceptance.json` under
`.dsh-test-tools` passed all six cases. A deliberately rejected operation remains
in the Human outbox as `state:'failed', error:'FORBIDDEN'`; it is not evidence that
an authorized action failed. After the GUI stop file or expiry, require final
`cleanedUp:true` and `temporaryProfilesDeleted:true` before claiming cleanup.
