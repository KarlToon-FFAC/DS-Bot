# Scoped Hub trust and local-layout comparison

## Implementation and evidence

This batch is based on `4b90828` on `chore/federated-communication`. All data,
accounts, certificates and model responses used below are isolated synthetic
fixtures on 88. No production Hub/database, OS trust, firewall or actual remote
machine was changed. No real model was called.

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Paste a private-CA Hub code | Signed v2 code contains exact Hub ID/address, public roots and leaf chain, bounded dates and signature. Client validates code locally, then performs normal TLS with explicit per-socket CA. | Generated-CA real WSS tests: tampering, unknown fields, expiry, hostname rejection, leaf renewal, root replacement; missing confirmation contacts no Hub. |
| Persist only scoped trust | Existing SDK device record contains public trust bound to one Hub ID and exact URL. Socket creation reads that record after restart. | Fresh real DSH A/B joins, administrator approval, configuration reload, signed DM/group delivery, restart/reconciliation without client CA environment setup. |
| Explicit CA updates | Human-only GUI and `update-hub-trust` CLI verify a real Hub challenge before writing; concurrent identity changes reject the update. No enrollment proof is submitted by this action. | Unit negative identity/authority cases; real Human CLI challenge/update preserves the enrolled instance. Root replacement exercised by real WSS unit integration; full native root replacement remains a separate deployment rehearsal. |
| Old/new compatibility | Legacy v1 retains strict ambient TLS. Old clients reject v2. No silent trust downgrade. Owner configures `management.pairingCaFile` once. | Legacy parser/strict connection and existing suites pass. No actual old-binary cross-machine rollout performed. |
| Remember password | Standard native form with username/current-password autocomplete. Browser password manager owns optional saving; application stores no password in web storage. Session bootstrap preserves existing 15-minute session across refresh. | Actual Chrome form login, refresh, revoke-all and return to sign-in. No test password saved in browser manager. HTTP tests also cover logout, CSRF, wrong origin, bad form credentials, password rotation and session revocation. |
| Independent administration | No admin page entry in remote sidebar, personal settings, contact manager or pairing guide. `/admin/` remains standalone. | GUI absence assertions with enabled, disabled and unsafe advertised URLs. Owner startup docs updated. |

The actual browser identified a `no-referrer`/native form Origin incompatibility
that synthetic HTTP alone did not detect. The page now uses `same-origin`
Referrer Policy; strict Origin/Host checks and CSRF remain intact. Failed native
login returns the sign-in page with a generic error and never echoes inputs.

## Full local GUI comparison

The native local group **Local layout reference** was created in a fresh DSH
profile with Chief/Reviewer, opened in Chrome, sent a synthetic @Reviewer message,
and inspected together with its header/details. The native DM and source
components (`sidebar.js`, `header.js`, `user-message.js`, `composer.js`, `mark.js`,
`styles.js`) provided the reference. This is a layout/interaction adaptation, not
a claim of pixel identity or all native capabilities.

| Area | Remote result | Preserved difference / limit |
| --- | --- | --- |
| Left sidebar | Native-sized 280px column, 54px avatar rows, group avatar overlap, name/gray preview, selected background, unread dot. Connection card reduced to a compact status line. | Remote device/consent workflows stay in modal pickers and personal gear; no local Main-Bot promotion card. |
| Header | Centered native-style title pill with actual DM/group avatar; click opens member details/participant information. Activity and local close use compact icons with accessible labels. | Remote membership/identity authority differs from local Sessions. |
| Transcript | Aligned incoming avatar/name and rounded bubble; own bubble right-aligned; compact timestamps and hover/focus reply actions. Long/raw receipt rows moved out of messages into existing activity diagnostics. | Remote content remains text/Markdown, scoped to current authorized membership. No local tool traces, other Session content or memory is exposed. |
| Mentions/work | Existing avatar+name mentions and canonical started event retained inside the new layout. | Display mentions do not imply Bot wake targets; anti-echo protocol is unchanged. |
| Input | Native-like rounded, bounded composer with icon send, named placeholder, keyboard/IME handling and @ completion. Reply preview, retained drafts and same-send recovery remain. | Files, voice, scheduling and local model selection are not offered because remote protocol does not implement those capabilities. |
| Details/settings | Right-side member panel; desktop transcript resizes where space permits. One dirty Save, discard on close, focus returns to the title pill. | Remote owner/admin/speaking permissions remain authoritative; ordinary members only inspect. |
| Replies | Existing reference jump and nested branch viewer retained, including bounded indentation and branch rails. | This remains a modal reply context view rather than inventing cross-conversation local Session links. |
| Narrow/accessibility | Real 390×844 browser: one-column conversation navigation, visible usable composer, no document horizontal overflow; accessible icon labels and keyboard focus. | Touch shows message actions directly. |
| Theme | Uses native theme variables and existing theme/contrast regression coverage; real desktop/mobile dark and desktop light screenshots reviewed. | Appearance changed through the normal settings UI of the disposable instance. |

Screenshots in `screenshots/`:

- `native-layout-reference.png`: actual original local group, dark.
- `remote-layout-desktop-dark.png`: actual remote group, dark.
- `remote-layout-desktop-light.png`: final actual remote group, light.
- `remote-layout-mobile-dark.png`: actual 390px group.
- `remote-layout-private-mobile.png`: actual 390px DM.
- `remote-layout-readonly-members.png`: ordinary read-only member inspecting members; no send/edit controls.
- `hub-native-login.png`: standalone native login form.

The prepared-upload helper first failed TLS, then reported prepared uploads
unavailable before preparation. The supported direct create route subsequently
saved both requested comparison images successfully:

- Remote: `libfile_2f58740759488191beb62308c161a6c3`.
- Original: `libfile_f38f02b03ca081919ef26af05e8f7565`.
- Final light: `libfile_4a197aeea78c8191b2331b0e6bd8d989`.

Windows lacks the helper's `os.setxattr` API, so local extended-attribute
writeback failed; the Library items themselves are saved. The local files remain
the original review artifacts. No duplicate upload was performed after success.

## Regression results

- Plugin full suite: **1648 pass, 2 skip, 0 fail** (1650 total).
- Independent Hub full suite: **96 pass, 0 fail**.
- Final scoped trust suite: **3 pass, 0 fail**, including real WSS handshakes.
- Final focused UI/style/contrast suite: **49 pass, 0 fail**.
- Generated bundle freshness and lint pass (existing warning-only lint debt).
- Host modal focus regression: a legitimate host first-run/login dialog above a
  restored remote window retains focus/Escape rather than competing focus traps.
  This is unit-tested. Fresh A/B tabs subsequently worked. Some old tabs remained
  unresponsive, so their timeout is not attributed to a proven cause.
- Native signed enrollment A/B: eight recorded milestones/cases, including
  SDK enrollment/approval, publication/consent/avatar denial, DM/group/implicit
  reply with actual DSH sources, revoke/offline outbox fencing, read-only denial,
  unpublication, saved-trust process restart and real CLI trust update.

The cases span transport/server/session/browser layers. Same-machine A/B with
real TLS and Mock responses is not real cross-physical-machine validation.

## Current isolated playground

Started with the repository bench, using fresh prefix
`hub-onboard-0b5d9328`. It is temporary, not a Windows service:

- A: `http://127.0.0.1:3185/`
- B: `http://127.0.0.1:3186/`
- Browser management fixture: `http://127.0.0.1:3195/admin/`
- WSS Hub: `wss://127.0.0.1:3194/communication`
- Mock model ports: 8885/8886, also loopback only.
- Expires **2026-11-04 17:16:04 UTC**. Owner loss or explicit stop also cleans up.

At **14:25:54 UTC**, both authenticated local APIs reported connected and
reconciled, A with two conversations and B with one; scoped verified HTTPS
`/health` returned 200/`ok:true`. This proves local service access, not access
from another device. Local DSH startup opened the normal authenticated browser
flow. A new browser/profile still needs that normal startup login flow; no
startup token is copied into this document.

The retained A/B browser tabs were both verified open and placed in the remote
group. Eighteen duplicate/obsolete test tabs were closed. One old `:3101` tab was
retained because its renderer timed out and unsaved content could not be checked;
its server no longer listens. No forced discard or unrelated service stop was
performed. Thus browser cleanup leaves three tabs, not a falsely claimed two.

The HTTP management page is a test-only loopback browser adapter around the same
synthetic Hub. Its public fixture password is
`mock-only-hub-admin-browser-pass-20261104`; do not reuse it or expose this test
listener to the network. Real deployment must use trusted HTTPS for the browser
independently of client-scoped WSS trust.

To stop only these owned fixtures:

```powershell
New-Item -ItemType File -Force -Path D:/git/DS-Bot-federated/.dsh-test-tools/hub-onboard-0b5d9328-browser-stop | Out-Null
```

To reproduce after it stops (requires free listed ports and installed harness):

```powershell
cd D:/git/DS-Bot-federated/ds-bot
node --import ./test/harness-resolve.mjs dev/communication/hub-onboarding-acceptance.mjs --scoped-ca --live-for-browser --play
```

The normal fixture deadline remains 15 minutes; only opt-in play runs extend
their owned-process lifetime, bounded by four hours. The play holder stops in
three hours and deletes its disposable SDK profiles. No production data is
migrated. The code changes are prepared locally; this batch has not been pushed.
