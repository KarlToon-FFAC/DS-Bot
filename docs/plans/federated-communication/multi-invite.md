# Existing-group multi-select invitations

The user requests multiple selection when adding members to an existing group.
The invitation remains a separate native dialog. Checkbox choices preserve the
contact/Bot hierarchy, exclude current members/retired identities, and display a
selection count. Only Bots are selected; the existing Hub transaction includes
and deduplicates their canonical Human owners. Publication, contact, role, epoch
and capacity checks remain authoritative.

Each batch reads canonical group membership/version immediately before each new
invitation. A successful join can increment the version more than once when it
also adds an owner, so the next request never guesses a version increment. A Bot
already present is skipped. Successes are removed from selection; individual
failures stay visible and selectable for retry, with previously known display
names retained if a Bot disappears from the directory.

Queued/uncertain requests pause later invitations and retain their exact intent.
Retry uses the original operation ID, epoch and expected version through the
existing durable operation map, including after surface remount. Such targets
cannot be unchecked as if their already-submitted operation had been cancelled.
Remaining unsent selection can still be changed. Successful targets are not sent
again. Definitive permission/version/capacity failures stop the batch for review;
MEMBER_LIMIT is preserved as a public, definitive rejection rather than disguised
as an uncertain result. Failed preflight reads submit no invitation.

Controls cannot change while the batch runs. Scope unmount prevents subsequent
items from being submitted or late results from affecting a new conversation.
Group settings drafts stay independent. No Hub protocol, backend membership rule
or release number changes; this follow-up remains V0.3.1.

## Verification — 2026-11-10

- Plugin: 2,086 tests, 2,081 passed, five skipped, zero failures. Generated client
  consistency and lint passed; existing warnings remain.
- Regression coverage includes two selected Bots sharing one owner, canonical
  versions 1→3 between requests, partial failure/retry, uncertain ACK/remount with
  the same operation ID/version, and definitive capacity rejection with editable
  selection. Existing single-operation busy/focus and group-dialog tests pass.
- `multi-invite-acceptance.mjs` runs two isolated native DSH instances, an owned
  Hub and deterministic Mock. At 1280×900 and 390×844 the actual production GUI
  selected the local and remote Bots together, submitted the batch, verified both
  Bots plus their deduplicated owners in canonical membership, and observed the
  group on the remote instance. Zero browser errors; screenshots inspected.
- The native first-run overlay was dismissed with Escape; only the owned P0 test
  launcher buttons were hidden to reach the production sidebar. No production
  profile, real key or DSH internals were used. Owned processes stopped and test
  ports were released; logs/images stay in ignored test directories.
