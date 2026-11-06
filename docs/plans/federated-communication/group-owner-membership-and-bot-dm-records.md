# Group owner membership and Bot private conversation records

This change completes requests 9–12. The user confirmed that remote participants
must join and see the group immediately, without accepting an invitation.

## Missing groups: cause and server invariant

The local conversation list correctly selects the local Human's memberships.
Previously, inviting a Bot or creating a group as a Bot could leave its canonical
Human owner outside the group. Refreshing the browser could not supply that missing
membership. Adding an owner only in the group picker also left CLI and Agent paths
able to create the same inconsistent state.

The Hub now includes each group Bot's canonical Human owner in the same transaction
as the Bot. This applies to Bot-created groups and additions through GUI, CLI and
Agent tools. Adding a participant joins it immediately. The existing authorization,
contact policy, publication checks, membership epochs, version checks and capacity
limits still apply. Capacity failure rolls back both owner and Bot additions.
An automatically included Human is an ordinary member, not an additional owner or
administrator. Removing a Human also removes its dependent Bot memberships;
ownership must be transferred first if one of those Bots owns the group.

On startup, the Hub repairs valid saved invitations and active group Bot memberships
whose canonical Human owner never joined. Repair is idempotent and can recover an
active Bot even after the original inviter has left. It checks actual stored Bot
ownership and membership; clients cannot supply this internal repair authority.
An explicitly departed Human is not silently rejoined: a remaining dependent Bot
is withdrawn instead. Capacity and authorization failures are deferred. DMs are
excluded from this repair. Existing join boundaries and history isolation remain
in force; the new Human membership does not grant earlier Bot-only history.

Deploy and restart both the Hub and the plugin. No reset or data deletion is needed.

## Member details

The member card shows the Bot's owning contact, avatar and address when available,
plus its public headline, summary and expertise. Ownership comes from canonical
principal IDs and authorized contact/member metadata, never from matching names or
addresses. Full public profile reads are scoped to a current conversation member.
Private Bot instructions are not requested or displayed. Unavailable profile reads
retain known public metadata and show an availability message.

## Bot private conversation records

Bot-to-Bot DMs remain canonical two-Bot conversations. The Human is not inserted
as a third member. The local owner instead gets a separate **Bot private chats**
section with read-only records for currently published, locally owned Bots.
The records use existing persistent messages and membership state, including
pagination and quoted-message lookup. They survive a Host restart.

The new local `bot-dm-history` and `bot-dm-reference` API/CLI reads validate the exact
local Bot, current membership epoch and two-Bot DM shape. They reject foreign Bots,
stale epochs, Human DMs and groups. These reads neither send messages nor acknowledge
them as the Human. The GUI offers no send/reply composer for these records. Normal
Human history reads still reject a Bot-only DM. `participant-profile` uses the same
scoped Bot context when opening a member card from a private record.

## Verification (2026-11-06)

All model-driven checks used deterministic Mock in isolated local profiles. No real
model key, production Hub or user DSH data was used.

- Plugin regression: 2,005 tests, 2,000 passed, five skipped, zero failures.
- Hub regression: 183 passed, zero failures. Coverage includes Bot-created groups,
  Bot-only additions, atomic capacity rollback, explicit departure, idempotent repair,
  repair after the inviter leaves, and two real disk-backed Hub restarts.
- Native DSH Mock smoke: all 52 steps passed.
- Real WSS Hub and two isolated DSH instances: all 15 complete-reset acceptance
  scenarios passed. Actual CLI-created groups appear on both sides without accept;
  a real Mock Agent creates a Bot-owned group with its Human included. A real
  Bot-to-Bot request/reply appears in the separate archive, survives Host restart,
  and can be read through the new CLI route while ordinary Human history is denied.
- Actual B browser kept open while A added only B's Bot: the group appeared without
  acceptance or document reload. A subsequent Bot DM record also appeared live and
  had no composer. No browser errors were reported.
- Chromium with production components/styles: member ownership and full public
  profiles, private records, desktop and narrow screens passed. Existing profile,
  group-picker and empty-log mention placement were rechecked.
- Lint and generated client consistency passed. All owned benches and topology
  processes were stopped after verification.
