# Bot publication lifecycle and existing-group picker

The user requires withdrawal (hide/unpublish) and local deletion to permanently
end a Bot's remote identity. Re-publication of the same local Bot creates a new
principal, even if its name, profile and instructions have not changed. Local Bot
identity/memory is independent of this remote publication lifetime.

Each withdrawal records a generation in the serialized configuration edit. The
local durable queue reconciles active identities and retains retired identity
mappings. Generation changes also work when an offline hide/show is coalesced into
one runtime reload. Fresh local principal UUIDs prevent restoring an old generation
value from resurrecting an old principal. A plain upgrade/restart or profile edit
preserves the active identity. If the Hub has already retired an identity from an
older local backup or schema 5 deployment, registration records that retirement
locally and publishes a fresh identity; it never revives the old principal. Missing local Bots are retired, not startup errors.

Hub schema 6 keeps permanent retirement tombstones and the exact last readable
sequence per retired membership. Retirement removes active memberships, default
reply routing and invitations, and revokes queued deliveries. Old principal IDs
cannot register or re-enable. Old messages and their hashes remain untouched.
Read-only archives are bounded at retirement, and ordinary writes, response grants
and native work authorization cannot use that archival access. Human contact
revocation still fences private archive reads. A new identity needs a new DM and
an explicit group addition; it inherits no role or membership. Existing unavailable
owner behavior is retained if the retired Bot owned a group; no automatic takeover.

Conversation projections expose retired DM participants and former group members
separately from active members. Main messages, quotes, threads, private chat titles
and profile details mark the old identity as nonexistent. Owner Bot-to-Bot records
retain their exact original principal/epoch after withdrawal/deletion and restart.
The plugin requires the Hub's `bot-publication-generations` capability so an older
Hub cannot silently resurrect a retired identity. Deploy both Hub and plugin; no
reset is required. Schema 6 refuses older binaries rather than allowing downgrade.

The existing-group picker uses radio inputs. Generic full-width text-input styling
previously included radios, pushing Bot names outside the dialog. Exclude radio and
checkbox controls from that styling, keep control widths fixed and wrap Bot names.
Verify selection and visible labels in Chromium at desktop and mobile widths.

## Verification (2026-11-09)

Plugin: 2,030 tests, 2,025 passed, five existing skips, zero failures. Hub: all 195
passed. Generated bundle freshness and lint passed. Native DSH Mock smoke: all 52
steps passed. Regression coverage includes generation coalescing, durable identity
rotation, retirement rollback, schema 5 migration without canonical message edits,
read bounds, exact-epoch private archives, contact revocation, old-session export
and work refusal, and cancellation on the other side of a retired DM.

Real WSS Hub + two isolated DSH instances with Mock passed seven lifecycle cases:
contact/group creation visible on both devices; actual remote group reply;
withdrawal reflected in group/Human-DM records with owned Bot DM retained; new
identity and explicit group rejoin/new DM; live local deletion reflected remotely;
Host restart retaining the fresh principal and original private history despite a
stale deleted config entry; and Hub restart retaining retirement and archive reads.
All owned processes stopped, ports released and successful integration profiles
removed. No real model key or user DSH data was used. This mode does not claim the
separate offline-reset suite was executed.

Re-run the actual lifecycle mode from the repository root:

```sh
node --import ./ds-bot/test/harness-resolve.mjs \
  ds-bot/dev/communication/complete-reset-acceptance.mjs --publication-lifecycle
```

Chromium with production components and synthetic records verifies desktop/mobile
radio/name bounds, actual selection, retired message attribution, read-only private
records and old identity details. The standalone script uses an installed Playwright
module, optionally selected with `DSBOT_PLAYWRIGHT_MODULE`; `DSBOT_CHROMIUM_PATH`
optionally selects the browser executable:

```sh
node ds-bot/dev/communication/publication-ui-acceptance.mjs
```

Safe counts and scope: [evidence](bot-publication-lifecycle-evidence.json).
Screenshots: [desktop invitation](screenshots/existing-group-invite-desktop.png),
[mobile invitation](screenshots/existing-group-invite-mobile.png),
[retired identity details](screenshots/retired-bot-details.png).
