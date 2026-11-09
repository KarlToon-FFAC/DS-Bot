# Remote Hub switch acceptance — V0.3.0

Verified on 2026-11-09 using Node 24.22.1, the pinned native DSH harness,
owned `.dsh-test-*` profiles, deterministic Mock models and loopback Hubs.
No production Hub, user profile or real model key was used.

## Behavior

- General settings contains **Enable remote Hub**. Fresh installs default off;
  legacy joined/configured profiles infer on only when the explicit flag is absent.
  Explicit off survives restarts. The local sidebar and restored remote panel obey
  the flag; disabling also fences Host APIs and existing Bot tools.
- Disabling uses a separate modal and requires explicit server-checked consent
  plus the reviewed configuration version. Cancellation, stale review, read-only
  access and unconfirmed requests leave configuration and publication unchanged.
- Confirmed disable stops normal communication, cancels remote approvals/work,
  clears the published list and rotates publication generations. Cleanup only
  authenticates and submits an empty publication list; it never pumps queued
  messages or starts Bot execution.
- Hub acknowledgement permanently retires old Bot identities and memberships.
  Its completion is durably journaled against the scoped withdrawal intent.
  Offline failure remains visible and retries after Host restart/Hub recovery.
  A completed restart reads the journal without reconnecting to withdraw again.
- Re-enabling restores no publications. Explicit publication creates a fresh
  identity; group access requires an explicit new invitation. Local Bots/files,
  local chats, contacts and saved Human enrollment remain available.
- Signed SDK enrollment, Hub-scoped private CA, paused credentials and restart
  were exercised with real native DSH instances. Cleanup does not resume paused
  enrollment. Remembered publication snapshots are cleared so selecting the Hub
  again cannot restore old publications.
- Hub/plugin release metadata is V0.3.0. Protocol and capability requirements are
  unchanged; release-number differences alone do not reject a compatible peer.

## Checks

| Check | Result |
| --- | --- |
| `npm --prefix ds-bot test` | 2,073 tests: 2,068 passed, 0 failed, 5 skipped |
| `npm --prefix communication-hub test` | 199 passed, 0 failed |
| Plugin lint and generated client check | Passed; existing lint warnings remain |
| `remote-hub.test.js` after final disabled-state projection change | 7 passed |
| Native smoke using isolated ports 3415/9115 | All 52 steps passed; bench stopped |
| `remote-hub-switch-acceptance.mjs` | Two DSH instances: opt-in/migration, confirmation denial, online withdrawal, restart off, new publication identity, offline withdrawal/restart/recovery passed |
| `hub-onboarding-acceptance.mjs --scoped-ca --enroll-only --remote-hub-switch` | Fresh SDK enrollment/admin approval plus scoped-CA paused withdrawal/restart/resume passed; owned profiles removed |
| `remote-hub-settings-ui-acceptance.mjs` | Chromium at 1280×900 and 390×844: hidden/default entry, enable, separate warning, Escape cancellation, confirmation and pending state passed; zero browser errors |
| `navigation-ui-acceptance.mjs` | Existing desktop/mobile/rail navigation, pending badges and compatibility reason passed; zero browser errors |
| `git diff --check` | Passed |

Browser runs use the production React components/CSS with synthetic authorized
state. Native runs cover the real Host/SDK/Hub/CLI paths separately. These checks
do not claim a cross-physical-machine or production deployment test. A Hub that
remains unreachable cannot acknowledge withdrawal; the local feature stays off
and the settings page continues to report pending cleanup.
