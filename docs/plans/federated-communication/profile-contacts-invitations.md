# Personal profile, contacts and group invitations

Current CLI/Agent scope defaults, invalid-code errors and explicit legacy scope
repair are described in [contact-consent-repair.md](contact-consent-repair.md).
They supersede the older empty-default and opaque-invalid-code choices below.

The user's eight requested changes are implemented together:

1. Personal settings groups the Human profile, user code, publication selection and
   local Bot public profile editors. Publication removal uses the existing versioned
   configuration update; local Bot identities and private chats are preserved.
2. Contacts and new-message pickers exclude local Bots. Group selection still offers
   local Bots in a separate local-owner section.
3. GUI contact requests have no per-request sharing controls. Explicit contact consent
   covers currently published Bots and later publications. Unpublishing hides a Bot;
   revocation fences its DMs even if it has already been unpublished. Existing explicit
   Bot scopes and approved model-management operations retain their narrower semantics.
4. Language fields are removed from profile editors, displays and directory searches.
   Existing stored language metadata remains readable for protocol compatibility.
5. Group creation shows each contact with their address on one nonselectable row;
   only Bot checkboxes are selectable. The canonical owner is included automatically,
   deduplicated when several Bots have the same owner.
6. Group additions now join immediately at the Hub, for local and remote participants.
   Every group Bot has its canonical Human owner included, including Agent-created
   groups and CLI additions. Role, capacity and epoch checks remain authoritative.
7. Older pending invitation details remain grouped by exact group and canonical
   inviter. New group additions require no acceptance dialog. On startup the Hub
   repairs valid older requests and groups whose Bot owner had never joined as a
   Human. A prior explicit departure is preserved rather than silently resumed.
8. An empty message log remains the flexible space above the bottom composer, keeping
   mention choices visible above it at both desktop and narrow viewport sizes.

Hub invitation metadata is derived from stored principals and observed addresses;
request bodies cannot invent its origin. New contact publication scopes are stored
as an internal wildcard, expanded only to the owner's published Bots when reading.
DM revocation expands the scope to all owned Bots so withdrawing publication cannot
leave old DM epochs valid. The Hub advertises `published-contact-scope`; a newer client refuses the simplified
contact operation against an older Hub instead of silently granting an empty scope.
Deploy the Hub and plugin together for this behavior.

## Verification

Validated in isolated local test profiles with deterministic Mock only:

- Plugin suite: 2,000 tests, 1,995 passed, five skips, zero failures.
- Hub suite: 178 passed, including local membership authority, publication changes,
  canonical invitation source metadata and revocation of unpublished Bot DMs.
- Two real DSH instances: the complete reset/re-enrollment acceptance passed all ten
  scenarios using contact requests without per-request Bot lists and direct local
  Bot joining without a separate accept operation.
- Chromium with production components/styles and synthetic API fixtures: desktop
  1280 × 900 and narrow 390 × 844, no page errors. Confirmed profile settings,
  remote-only contacts, Bot-only group selection, consolidated invitation details,
  bottom composer and unclipped upward mention choices in an empty conversation.
- Client build consistency and lint passed. Test processes and browser fixtures
  use no real model key, production Hub or user DSH data.
