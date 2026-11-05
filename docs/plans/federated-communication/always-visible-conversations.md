# Always-visible remote conversations

## Requested behavior

Remove **Show closed conversations** and **Close on this device** from remote
communication. Every conversation supplied by the currently authorized snapshot
appears in the list and remains searchable. There is no per-conversation local
close/hide control. The sidebar's layout collapse and return-to-local-chat controls
remain unchanged.

## Compatibility and authorization

The previous local-close list lived only in browser session storage under
`ds-bot:communication:hidden`. No Hub or host record represented this preference.
The UI no longer reads or writes that list. Old, malformed and Hub-qualified values
are inert, so formerly closed groups and DMs immediately return without a migration,
data deletion, membership request or message send. Drafts, uncertain send intents,
message IDs, history and membership epochs retain their existing storage and rules.

The server still decides the authorized snapshot. Removing a UI preference cannot
recover a departed membership or fabricate access after a Hub change. The Hub's
`conversations.closed` field represents group dissolution, not local visibility,
and is unchanged. Explicit leave/end-group operations, privacy, retained deleted
objects and the separate local-chat sidebar mechanism are outside this change.

## Verification

- Plugin full regression: 1767 tests, 1763 passed, four existing skips, zero failures.
- Communication usability: 56/56 passed, including three legacy-close cases with
  valid lists, malformed JSON and the wrong JSON shape. They cover groups and DMs,
  initial list counts, search, repeated selection, remount, draft and pending-intent
  preservation, Hub changes and authorization removal without restoring membership.
- Build, generated client/office freshness, lint and whitespace checks passed.
  Existing lint warnings remain; this change adds no lint errors.
- Official managed internal preview with the real cloud browser: desktop group
  restoration and saved history/draft; removed settings and close controls; keyboard
  search selection; app reload retaining both rows and the original draft; 390px
  dark phone list and DM navigation. The phone document and scroll widths are both
  390px. No horizontal overflow was observed.
- Browser validation used production React components/styles with synthetic
  in-memory state and a simple Markdown primitive. It did not authenticate to a
  Hub, start a DSH host or call a real model. Mock DOM tests remain distinct from
  browser layout checks and live cross-device delivery.

Private browser evidence and screenshots are in the ignored
`.dsh-test-tools/show-all-conversations/` directory. The internal preview was stopped
and its temporary browser tab was closed. No application or user data was changed.
