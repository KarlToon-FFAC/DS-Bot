# Communication GUI usability review

Review snapshot: local implementation and UI acceptance completed on 2026-11-03.
Changes were intentionally left uncommitted at that review; the owner authorized
publication to the implementation branch on 2026-11-04. The accompanying evidence
records the earlier review state, not a live publication status. Baseline:
`ce9d74395c1eca4afcb040bd3aae21dc4283ec29`.

## Problems and changes

| Observed problem | Resulting behavior |
|---|---|
| Communication disappeared entirely before configuration | The existing sidebar entry remains available and explains that the Hub owner must configure pairing. This screen makes no communication API calls and grants no access. |
| Contacts and group creation were buried in disclosures | Explicit New message / New group actions open the corresponding section; group creation focuses the name field. Invited identities retain machine, Human/Bot and local/remote labels. |
| Connection state and failures were hard to interpret | A connection card shows device identity, remote contact count, readable errors and Refresh status. Terminal pairing/version/fencing errors are distinguished from automatic reconnect. The refresh action reads state without resending messages. |
| Group creation could succeed before a later invitation failed | The created group stays selected, the creation form is cleared and a partial-invitation message directs the user to member settings. The UI does not create a second group or silently retry invitations. |
| Member controls squeezed the message log | An independently scrolling drawer shows owner/admin/member roles separately from Human readOnly/speak and Bot passive/active settings. Close remains reachable during scrolling; Escape closes the drawer before the communication surface. |
| The fixed two-column layout narrowed phone conversations | At 760px and below, the list and chat use separate full-width views. Returning to a conversation preserves its input. Current role, speech permission and member count appear in the header. |
| Raw send states gave little recovery guidance | Failed publications show a readable reason; unconfirmed sends explicitly retain the original-send retry flow. The status disclosure distinguishes stored, Human read and Bot admission from a completed reply. |

The implementation follows existing theme tokens, type sizes and English source
copy with Chinese translations. Styles were extracted into
`ds-bot/src/client/communication-styles.js`; `ds-bot/client.js` was regenerated.
No Hub, host adapter, server authorization, schema, model prompt, protocol or
API route changed. The previous send intent/message ID and membership epoch
checks remain intact. An always-visible entry does not enable communication.

## Verification

- Full plugin regression: **1494 tests, 1492 pass, 2 original skips, 0 failures**.
- Three added usability cases cover disabled pairing with zero API calls;
  partial invitation failure without duplicate creation; and status-only refresh,
  draft retention, permission errors, drawer Escape and close-focus behavior.
- Existing UI tests still verify that an uncertain send retries the identical
  persisted payload and ignores late history responses.
- Build, generated-client freshness, lint and whitespace checks pass. Existing
  non-failing lint warnings remain.
- Real browser inspection used the ChatGPT in-app browser with the production
  communication component/styles and synthetic state. Desktop 1280×720, phone
  390×844 and tablet 700×900 were checked. At 390 and 700px, document width equals
  viewport width; the tablet composer measures 676px. A scrolled phone member
  drawer retained its close button at y=16–48px with scrollTop=203px.
- Light/dark themes, offline queue guidance, unconfigured pairing, member
  permissions, list/chat navigation and group invite selection were inspected.
  Temporary viewport overrides were reset and the created browser tab was closed.

Screenshots and private test output are retained locally under the ignored
repository-root `.dsh-test-tools/ui-review/` directory:

| File | View |
|---|---|
| `desktop.jpg` | Default desktop communication view |
| `member-drawer.jpg` | Desktop group role and speech controls |
| `mobile-chat.jpg` | Phone conversation and composer |
| `mobile-members.jpg` | Phone member permission drawer |
| `mobile-create.jpg` | Phone group creation and remote identity selection |
| `tablet-chat.jpg` | 700px conversation layout |
| `dark.jpg` | Existing dark theme |
| `offline.jpg` | Reconnecting and queued-publication guidance |
| `setup.jpg` | Unconfigured device pairing guidance |

Hashes and verification scope are recorded in `gui-usability-evidence.json`.
Screenshots are local review artifacts, not repository assets. The preview uses
in-memory synthetic state and a simplified Markdown primitive; it does not start
a DSH host, authenticate against a Hub or call a model. These screenshots verify
layout and interaction, not live network delivery or Markdown rendering.

## Handoff

The test preview listens only on loopback and is stopped after capture. No actual
DS-Bot trial process was restarted and no C2 connection, credential change or
real-model request was made. Existing encrypted credentials and SSH keys were
not accessed. Different-machine acceptance remains with the separate C2 trial.

Review the local diff and screenshots before any commit or push. To load the UI
in a normal source-launched app, quit it and use its existing source launcher so
the regenerated plugin is copied into that app's installation; coordinate this
with the real trial rather than restarting its running host automatically.
