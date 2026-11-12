# Remote communication follow-up acceptance

Published baseline: `37738c6b4b96bf74e7c12dc0f9906558037f8ca6`.
This covers the complete ten-item follow-up and retains earlier Remote IM,
Memory10000 and Main Bot local workspace requirements as regressions.

## Requirement matrix

Paths are repository-relative. Private evidence is under ignored `.dsh-test-tools`.

| # | Implementation | Positive and negative evidence | Status |
|---|---|---|---|
| 1 Bot collaboration | Hub `store.js`, plugin `federation/runtime.js`, queue, transport and prompt | Baseline `bot-collab-e1e9fe59-acceptance.json`: seven cases including Human→A→B→A, @all, roles, depth8/root32, duplicate/recovery. Follow-up reply suite regresses bounds and silent automatic finals. | Passed |
| 2 Reply without @ | Hub explicit reply routing; unchanged GUI/CLI/tool reply field | `settings-reply.test.js`: Human/active Bot exact original Bot, explicit mention override, passive grant checks, foreign/old-epoch denial. Actual DSH `reply-settings-c087a6f1-acceptance.json`: eight cases with exact input/delivery/grant matching. | Passed |
| 3 Group settings autosave | Client `communication.js`; Hub atomic settings, CLI save-settings and scoped Bot tool | Atomic validation/storage rollback, one version, retry, stale version/ID/role/epoch rejection. Supersedes manual Save: immediate member controls, debounced name, close flush, serialized atomic requests, uncertain-outcome retry and concurrent edit preservation. | Passed |
| 4 References | Client model, component and styles | Authorized inline quote, 160 Unicode codepoints including ellipsis, muted 12px. Actual one-shot jump, scroll across polling, composer focus and outside-click highlight clear. Missing/foreign/old-epoch reads denied. | Passed |
| 5 Bot/Human avatars | New Hub/plugin `avatars.js`, client `communication-profile.js`, runtime sync | Six Hub cases: native seed/shape/color, atomic chunks, owner/read authorization, hash/type/size, no URL/SVG. Three plugin cases: custom/reset/reverting look. DOM revision/cache/name tests. | Passed: full six-case A/B and eight new browser checks |
| 6 Read-only roster | Client group panel; Hub member/settings authorization | Actual ordinary member sees four members, zero Save buttons/policy controls. Service/CLI unauthorized changes, owner escalation and stale epoch rejected without partial mutation. | Passed |
| 7 Error placement | Client component/styles/i18n | Actual version conflict has no sidebar failure/alert text. Routine membership/routing notice and bottom box absent, not relocated. Actionable errors remain outside chat in relevant action/dialog feedback. | Passed |
| 8 Hub page/codes/consent | New Hub `management-*`, admin CLI; plugin `federation/onboarding.js`; client `communication-onboarding.js` | Thirteen management tests plus real HTTP/WebSocket integration: password/session/CSRF/Origin, proof purpose/socket/revision/expiry/replay, approval/revoke/repair, scopes/rates/code privacy/DM fencing. Twenty-three SDK adapter cases. Minimum fresh actual DSH A/B enrollment passed. | Passed: full six-case A/B and eight new browser checks |
| 9 Compact identity | Client model/component and native avatars | Name first; accessible Bot/Human/remote icons, full tooltip, same-name origin/ID distinction. Actual chat screenshot and DOM checks. | Passed |
| 10 GUI/CLI/Skill/push | Forty-two Human API actions, strict CLI, packaged Skill and concise core prompt | Thirty-seven targeted CLI/prompt/budget tests, Skill validation and package dry-run. All mutations executable, scoped Bot tools unchanged. Full A/B and exact staged scan pass; approved branch publication follows the release procedure below. | Passed; publication recorded by Git |

## Recorded verification

- `reply-settings-c087a6f1-acceptance.json`: eight actual DSH A/B cases.
- `reply-settings-gui/browser-evidence.json`: nine actual browser checks, with
  dirty Save, concurrent draft, inline quote/free scroll and read-only screenshots.
- `follow-up-plugin-release.log`: final transport lifecycle fix included,
  1595 total, 1593 pass, two existing skips, zero fail.
- `follow-up-hub-final.log`: 78/78, including real WSS certificate/hostname rejection.
- `follow-up-lint-release.log`: zero errors; existing warnings.
- `follow-up-native-smoke-final.json`: 52 native steps, exit zero, owned processes stopped.

The complete fresh enrollment/consent scenario found that pending-outbox capacity
errors starved inbound projection and then unnecessarily disconnected the socket.
The transport now defers only per-item capacity errors until other work synchronizes, keeps the authenticated socket available with bounded backoff, and preserves the original durable intent. Five focused tests, 114 communication tests and the fresh full scenario pass. Earlier incomplete/failed runs are not passes.

The older Electron suite retains four Windows junction/symlink failures
(227 pass, four fail, one skip); this follow-up changes no app production source
and does not claim that suite is green.

- `hub-onboard-79b6eede-acceptance.json`: full six-case actual DSH/SDK approval, publication/consent, DM/group/reply grants, revoke/reconsent/old-intent denial, avatar/read-only checks and unpublish/@all. Final cleanup confirms all five owned ports free and both temporary SDK-key profiles deleted.
- `hub-follow-up-gui/browser-evidence.json`: eight actual browser checks and seven screenshots for Hub page/code, contact/publication, Human avatar save/remote display/reset and read-only roster. Invalid image decode reports failure; valid packaged icon succeeds. All three owned browser tabs closed.
- Final build and generated-client freshness check passed.
- Exact staged-tree scan: zero must-fix findings. Informational results are
  vendor references, migration names, public fixture addresses and existing
  attribution; no credential, private runtime file or screenshot is staged.

## Setup, compatibility and limits

Use **Remote communication → Add a device**: paste the Hub code, review its actual
address/ID, request access, have the administrator verify its fingerprint and
approve, then check status to save via the public DSH Config Editor and reload.
Choose publication and mutual contact scopes explicitly under Manage contacts;
default Bot sharing is none. The Hub's own page and admin CLI manage admission.

Hub codes contain the real trusted WSS locator and stable Hub ID. They are public
metadata, never authentication, automatic discovery or NAT traversal. No firewall,
certificate trust, persistent service or external device was configured here.
Signed keys remain in the DSH credential provider; its default is an
OS-account-protected **plaintext** file, not encryption or isolation from same-user
programs. The unrelated previously approved model API DPAPI vault is unchanged.
Temporary test SDK records are deleted by owned-profile cleanup.

One stable Human is assigned to each new instance. Legacy Humans/IDs and static
pairing remain compatible; observed IP groups display and never authenticates.
Contact revoke fences old DM intents and stops new invitations while shared
groups keep their own authorization. Same-key explicit instance repair increments
revision and does not revive old group memberships. Unpublished Bots disappear
from discovery/new AI recipients but retain historical identity.

A passive Bot may use its current one-use final response to explicitly hand off.
An active Bot may proactively send within current permissions. Explicit tool
replies target their Bot author; automatic final reply references stay silent.
No prompt or UI substitutes for server permissions. Memory remains 10000 UTF-16
code units; authorized Main Bot workspace changes remain local and approval-bound.

These are real DSH processes with deterministic **Mock models on one Windows
machine**, not physical cross-machine or real-model acceptance. Upgrade Hub first,
then clients. See [management design](management-design.md),
[two-machine trial/rollback](two-machine-trial.md) and
[Hub operation](../../../communication-hub/README.md).
Rollback requires matching code and an offline pre-upgrade database backup;
do not open migrated state with older code.

Release procedure: commit the reviewed index, non-force push only to
`KarlToon-FFAC/DS-Bot:chore/federated-communication`, then read the remote SHA back
and compare it to local HEAD. The delivery report records that result. No main/docs
rewrite is authorized. No additional functional acceptance remains pending here;
physical network/certificate deployment and real-model validation remain separate.

## CI dependency-isolation correction

The first published follow-up (`ae4e4b8`) failed its four plugin CI matrix jobs:
the new fairness test imported the sibling Hub server, but plugin jobs correctly
install only plugin and DSH harness dependencies. Node resolves the server's `ws`
dependency relative to the Hub package, not the importing plugin's installation.
An existing developer Hub installation masked that error. All four job logs show
this same single module-load failure; independent Hub jobs passed.

The three pure queue/transport cases remain in the plugin suite. The two real Hub
socket lifecycle cases now live in `communication-hub/test/transport-fairness.test.js`,
where the existing Hub CI jobs install the server's locked dependency. Their
assertions and coverage are unchanged; no test is skipped and no resolution hook
or production dependency path is altered. A fresh exported tree with no Hub
`node_modules` reproduces the old server import error and passes all three pure
plugin cases. A second fresh tree installs only the Hub lockfile and passes all
80 Hub tests, including both moved cases. The release report records clean full
plugin verification and the follow-up CI status separately.
