# Local Bot management without publication

Publication controls whether a Bot has a usable Remote participant identity. It
does not control whether that Bot can help the local owner inspect contacts or
change the owner's selected contacts and published Bots.

## Separate authority paths

| Context | Authority and operations |
| --- | --- |
| Bot's current original local chat, direct host-authenticated user input | Read the local owner's contacts and publication list, including before the Bot is published |
| Same context, exact native approval | Request/accept/reject/cancel/revoke contacts, rotate the user code or replace the published local Bot list |
| Published Bot communication tools | Continue to use that executing Bot's own principal and current Hub membership, roles, version and speaking permissions |
| Isolated Remote Session | Exact conversation/epoch only; no local owner management tools, even for a remote owner, admin or matching Human name |
| Bot handoff, schedule, local group or unknown journal source | Cannot grant local owner management authority |

The host derives the current private-chat Bot from `chatOwners` and finds the
actual tool call (or native programmatic root call) in the session journal. The
latest substantive input in that call's turn must be a direct user message or
the user's question-card answer. An old user turn, display name, quoted instruction,
tool argument or remote message cannot supply this proof.

Source authentication alone is not consent to an external action. Every contact
mutation and publication write additionally goes through the existing DSH approval
service for that exact action, target/Hub and Bot scope. Only `allowed-once`
proceeds. Rejection, cancellation, absence or uncertainty leaves that action
unexecuted. A changed pairing, runtime identity, newly read-only state, cancelled
execution or concurrent publication selection also rejects the pending write.
These boundaries are rechecked when a queued action actually dispatches and
inside the asynchronous ConfigEditor mutation callback, not only after approval.

## Tools and compatibility

- `list_contacts` permits an unpublished Bot to read the owner directory only in
  the authenticated direct local context, returning `scope: "local-user"`.
- `manage_communication_contacts` exposes the bounded existing consent operations,
  not generic Hub calls or a configurable sender. Shared Bot scope defaults to
  none and only accepts already published local Bots. Requests and responses keep
  existing Hub consent, version and scope validation.
- `list_communication_bots` returns exact local IDs and publication settings.
- `publish_communication_bots` replaces the explicitly approved publication list,
  retaining other selected Bots unless the user asked to withdraw them. The
  underlying ConfigEditor checks pairing and the previously observed list before
  writing. `reloadRequired: true` means local configuration saved, not proof that
  the Hub has already reconciled publication.
- `create_bot` and `update_bot` retain their existing Main Bot/self-management
  permissions. This change does not authorize deletion or sandbox escalation.

The management definitions are not passed to the Remote runtime. Remote scope
assembly also explicitly filters their names and rejects execution. No credentials
are returned, borrowed or placed into tool arguments. Unpublished Bots are not
automatically registered or allowed to send as Humans. Hub enrollment, trust,
selection, resumption and administrator workflows are unchanged.

Contact mutation IDs are stable per actual tool source by default. When an
outcome is uncertain, the error returns the original `operationId` so an explicit
retry can retain it; no automatic new intent or silent mutation retry is performed.

## Verification

`communication-local-management.test.js` exercises the actual installed tool
collection, local-user and stale/injected source checks, native approval refusal,
precise owner/Bot scope, uncertainty IDs, publication concurrency, real host
runtime/time context, queued pairing/cancellation/read-only changes, Remote
assembly/execution exclusion and real in-memory Hub consent validation.
All data and identities are synthetic. No real Hub or model is needed.
