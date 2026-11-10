# Reset device cleanup and compact Hub administration

2026-11-10. Keep V0.3.1. No wire protocol, capability or schema change.

## Delete failure

Permanent device deletion omitted `principal_public_profiles`. A Human or Bot
with a published profile therefore caused a SQLite foreign-key failure when
removing its principal. The transaction rolled back, leaving the old device in
Hub state even if its client had lost all local identity data.

Delete that device's public-profile rows before deleting its principals, within
the existing administrator transaction. A regression publishes both Human/Bot
profiles and another device's profile, reproduces the original FK failure, then
verifies exact cleanup, retention of the other profile, and an empty
`PRAGMA foreign_key_check`. Existing message/history, group-impact/version,
admin authorization and socket-close protections remain unchanged. No approval
or surviving credential from the reset client is required.

## Compact administration

Devices now appear first in a bounded list, 25 rows per page. Each compact row
shows the device name, short identity, published Bot count, distinct Human name,
connection/access state and one Manage button. Connected devices sort first,
then names. Search accepts names, Human names and instance IDs; connection and
revocation filters include visible/total counts. Repeated name metadata is omitted.
Rename forms, full IDs, published Bot summaries and administrative actions are
in a native modal, rather than repeated for every device. The existing contact
and public-Bot directory remains available. Request history is collapsed with a
pending count.

Revoke, same-key repair and permanent deletion each open a separate confirmation
modal. Permanent deletion identifies the exact full instance ID and every owned
shared group that will close, including same-name-device cases. Payloads use the
versions observed when confirmation opened; a live version/group change disables
that confirmation. Failed/uncertain mutations never disappear optimistically or
retry automatically. Errors appear inside the active dialog. Escape cancels and
restores focus, modal native focus containment works on mobile, live refresh
preserves unsaved rename drafts, focus and their original optimistic version,
and session expiration dismisses management dialogs. Static-config peers still
require removal from their startup configuration to prevent resurrection; that
restriction now has an actionable explanation.

## Verification

- Hub suite: 199 passed, zero failed.
- Plugin suite: 2,104 total, 2,099 passed, five skipped, zero failed.
- Lint and generated-client freshness pass; existing unrelated warnings remain.
- `hub-devices-ui-acceptance.mjs`: Chromium against an actual disposable local
  Hub, with real admin cookie/CSRF, signed enrollment, 32 devices, public Human
  and Bot profiles, and a shared group. Desktop 1280×900 and mobile 390×844 have
  no horizontal overflow. Rows are bounded and measured compact, all modal
  cancellation/focus checks pass, and real rename/revoke/delete succeeds for an
  offline old identity while another same-name device and shared history remain.
  The browser reports zero page errors; FK integrity passes afterward.

Run from the repository root with Playwright available (or set
`DSBOT_PLAYWRIGHT_MODULE` to its module entry):
`node ds-bot/dev/communication/hub-devices-ui-acceptance.mjs`.
`DSBOT_CHROMIUM_PATH` selects Chromium; default is `/usr/bin/chromium`.
All test profiles, keys and data are synthetic, and owned browser/Hub processes
close in `finally`. No production data was deleted. Update and restart the Hub,
reload its admin page, then explicitly manage/delete the intended old instance.
Client updates and a Hub data reset are not required.

Preview: [desktop](screenshots/hub-devices-compact-desktop.png),
[mobile](screenshots/hub-devices-compact-mobile.png),
[delete confirmation](screenshots/hub-devices-delete-mobile.png).
