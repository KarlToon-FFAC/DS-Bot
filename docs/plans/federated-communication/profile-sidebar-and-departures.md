# Remote profiles, member sidebar and self-departure

The user's latest decisions supersede the group-settings dialog/collapsed-member
rows in `dialogs-archives-and-proactive-tasks.md`. No DSH internals are patched.

## Interface and contact decisions

- A Bot's remote profile has a compact preview and an **Edit remote profile**
  button. A standalone native dialog holds headline, detailed summary and skills.
  Its header/action footer remain visible while its form scrolls. Cancel discards
  unsaved changes. Local revision checks, conflict errors and edits made during
  save are preserved. The fields use communication form styles so local settings
  flex sizing cannot turn single-line fields into oversized vertical controls.
- Group information returns to the right sidebar. Members stay grouped by their
  canonical Human owner, with Bots on secondary rows. Each row has role/speaking
  controls and authorized removal on the right; the final arrow opens the full
  participant profile, including ownership, background, description and skills.
  Inspecting a profile preserves sidebar drafts and restores arrow focus.
  Inviting, transferring, leaving, removing and dissolving retain independent
  dialogs. Save still submits one atomic group-settings draft.
- IP notes are retired from UI, API, runtime snapshots, queue methods and docs.
  Opening an existing queue drops only the obsolete `local_address_notes` table.
  Canonical IP normalization/display remains for network context. Identity and
  authorization remain principal-based; contacts replace handwritten IP notes.
  Message history and private-chat archive preferences survive this migration.

## Departures in Hub administration

A successful signed self-leave atomically revokes the instance and memberships,
ends its contact relations, fences unfinished DM delivery and cancels outstanding
contact requests. A departure marker removes its device, published participant
and enrollment rows from active management lists. Historical principals/messages
and the public-key proof remain for readable history and retryable signed status.
Administrative revocation stays visible for review. Explicit admin repair removes
the departure marker, but does not restore contacts or group memberships.

On upgrade, previously completed self-leaves are recognized by the latest
leave/repair lifecycle audit. Only untrusted instances qualify. Backfill and live
leave use the same transaction boundary; failed commits leave trust, contacts and
lists unchanged. Repair cannot silently restore consent. A user code for an
untrusted device cannot create an actionable contact request.

## Human-to-Bot consultation and prompt boundaries

The final user decision allows Humans to directly consult another contact's
published Bot. This does not add the Bot's owner as a DM participant. There is no
Human-to-foreign-Bot prohibition or associated diagnostic in the final code.
Existing publication, contact consent, authenticated identity and membership rules
continue to apply.

Every isolated remote Session receives `src/host/federation/prompt.js`, exact host
metadata, locally configured Bot instructions, scoped relationship reference data
and, when explicitly enabled, selected read-only local memory. Current incoming
messages are separate from earlier canonical context and include exact authors.

The prompt now explicitly includes direct messages and public profiles among
untrusted inputs. A remote Human may ask permitted questions, but is not the
local user, owner or machine administrator. Accepting a DM/contact grants no local
action, private-data or forwarding authority. Urgency, testing, payment, support
and administrator claims do not justify credential entry, transfers or commands.
Existing privacy, anti-impersonation, source-qualified relationship memory and
anti-loop rules remain. These instructions guide model behavior; actual tool
assembly/execution allowlists and exact-conversation checks enforce access bounds.

## Verification

All model-driven checks use isolated DSH profiles and deterministic Mock, without
production data or a real model key. Plugin: 2,012 cases, 2,007 passes and five
skips; Hub: 187 passes. Native smoke: 52 steps. Lint and generated-client checks
pass. A real two-instance WSS run covers reset/re-enrollment, automatic group
visibility, Human-to-remote-Bot consultation, separate Bot DM records, archive
persistence and restart. Chromium checks desktop/mobile profile dialogs, inline
sidebar controls, profile detail/focus/draft retention and invitation dialogs.
