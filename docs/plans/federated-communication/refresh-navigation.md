# Navigation and automatic status updates

The Contacts toolbar button is the single entry to contact management. Personal
settings contains the user's profile, local-memory permission and Hub connection.
Its connection action is **Join Hub** (加入 Hub); returning from that guide restores
focus to the same action. Published Bots remain under Contacts.

## Automatic reads, explicit actions

Remote communication, activity, contact management, enrollment and the Hub admin
page have no manual refresh controls. Existing authenticated invalidation hints,
periodic fallback reads, visibility/online/focus recovery, single-flight reads and
bounded retry backoff remain in place. Dirty publication/name drafts and message
composers are not overwritten or submitted by an automatic read.

Hub configuration flags and the selected Hub ID are live roster fields, independent
of the saved team revision. Hot reload after approval, disconnect or Hub switching
updates them through the existing roster poll, including explicit false/null values
to clear disabled or removed configuration. The browser applies these fields before
skipping an unchanged team snapshot, so joining starts connection polling without
reloading the page. Connection checks retain their existing 750 ms interval while
the page is visible.

Enrollment reconciliation starts from the just-read saved snapshot, including on
first opening the guide. Saved pending requests and uncertain approval/configuration
results are checked automatically. Revocation and administrator repair of a saved
approved identity are also reconciled automatically. Reads never create a new join,
rotate trust, replace credentials, resume paused work or replay an operation. A
retained or repaired identity still needs the existing explicit resume confirmation.

Local-memory permission reads also follow automatic updates, with generation guards
against responses arriving after a save or a Hub switch. Failed reply-chain reads
retry at the same watermark without requiring a close/reopen; successfully loaded
pages are not discarded by every fallback tick.

A failed automatic read keeps a visible accessible stale-status error. Connection
state is no longer represented as current while a read is failing. Hub admin marks
device connectivity unavailable and displays a safe failure description while
reconnecting. Successful reads clear these automatic-read warnings; action errors
remain separate. Diagnostic guidance points to the current navigation and no longer
instructs the user to press a removed refresh button.

## Verification

Verified from base `673b12b`, using synthetic data and the mock/test harness only:

- Plugin full suite: 1,882 tests, 1,878 passed, four existing skips, zero failures.
- Hub suite run serially: 142 tests passed, zero failures.
- Client build, generated-bundle check and lint passed. Lint retains existing warnings.
- Official managed internal browser preview used production communication components,
  production styles and a synthetic request boundary, plus the production Hub admin
  page/script with synthetic responses. No production Hub, model or user profile was
  accessed.
- Browser checks covered the single Contacts entry, Join Hub label, exact return
  focus, automatic contact-name/request/approval updates, no manual refresh controls
  in contacts, activity, enrollment and admin, and visible outage warnings followed
  by automatic recovery. Admin changes updated device/request rows without refresh.
- Mock DOM regressions additionally cover publication drafts, hidden/focus recovery,
  session expiry, pending approval, repaired revoked identities without automatic
  resume, reply-chain recovery at an unchanged watermark, and local-memory settings
  read failure/recovery without writes.

The preview was stopped and its own browser tabs were closed. This change does not
claim destructive-reset/session invalidation coverage; those changes are verified
with their separate implementation and integration tests.
