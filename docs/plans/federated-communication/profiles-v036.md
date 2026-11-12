# V0.3.6: consistent profiles and group-specific presentation

Current Human profile names supersede enrollment names in default device labels,
contact origins, approved applications and current member lists. Explicit admin
aliases remain device aliases. Application history retains enrollmentLabel.
Existing databases obtain current display names on read without re-enrollment.
Avatar fetches recover after transient failures; current authorized revisions
replace cached member pictures. Unsaved personal previews remain independent.

The optional `group-profiles` capability adds two separate group features. Older
Hubs remain usable and simply do not expose the new controls. No mandatory
protocol change is introduced.

- Group owners/admins can upload or reset a group avatar in a separate dialog.
  The browser crops/compresses existing raster formats to 160 px, under 32 KiB
  encoded. The Hub validates and persists the image, exposes only its hash in
  membership metadata, and authorizes image reads by current membership. Reset
  restores the member-avatar cluster. Writes use existing operation IDs,
  membership epochs, group versions and state invalidation, including offline
  queued retries. Image bytes never appear in broadcast events.
- Group owners/admins can edit each member's multiline collaboration identity (up to
  4,000 characters) in a separate dialog. This is independent
  of global Bot profiles, management roles, speaking rights and tool permissions.
  Values are scoped to conversation + principal + membership epoch. Rejoining
  cannot inherit an earlier epoch's identity. All current members can read them;
  Bot prompts include this conversation's identities as reference data, and
  `read_communication_group_identity` retrieves full details within the authorized
  conversation. The member list and detail panel display the group identity.

New tables have cascading conversation/principal deletion. Existing database schema
v6 is extended additively; reset continues to erase the whole database. Display
metadata cannot grant authority. Oversized member snapshots compact optional
identity text, explicitly marking it as truncated; the explicit identity read remains complete.

Release: plugin and Hub V0.3.6. Validation (2026-11-12):

- Plugin: 2,152 tests; 2,147 passed, five existing skips, zero failures.
- Hub: 218 passed, including permissions, concurrent versions, persistence,
  rejoin epochs and bounded identity metadata with complete authorized reads.
- Native DSH with deterministic Mock: all 52 smoke steps passed; bench stopped.
- Chromium: contact manager recovery after the first avatar fetch fails, current
  name/image changes in the open manager, Human/Bot/Bot-to-Bot DM avatar
  replacement/removal, group avatar upload/reset and multiline identity editing.
- Lint, generated-client freshness and whitespace checks passed.

Update both Hub and plugin to expose the new controls. No user data reset is needed.
