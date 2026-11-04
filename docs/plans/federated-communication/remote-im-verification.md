# Remote communication follow-up verification

Date: 2026-11-04. Base commit: 939ca218d0ced40311fbd80a6bd20f2108d69a21.
Source version: DS Bot 0.2.6, DSH 0.2.1-rc.4, Hub 0.1.0, Node 24.13.0.
All feature tests use synthetic data and local deterministic Mock models. No
physical second machine, SSH, paid model API or user profile is part of this run.

## End-to-end evidence

- Fresh real DSH A/B + real Hub + CLI: **8 grouped cases passed**, **24 distinct
  CLI operations executed**, including retained-owner recovery after explicit
  revocation/re-pairing. Reproduce with
  `node ds-bot/dev/communication/remote-im-acceptance.mjs`.
- Actual browser against fresh real DSH A/B: **9 cases passed**, including modal
  creation/invitation, typed @all and exactly two passive Bot replies, Human send,
  revoked speech and server denial, disconnected Hub queue and original-ID
  exactly-once recovery. Human rename and IP/instance chooser were also inspected.
- Seven native recovery checkpoints: **7/7 passed**, with one final message per
  original logical input. The after-injection recovery may require another model
  attempt, while duplicate export remains prevented.
- Hub security/directory/governance suite: **39/39 passed**.

Private local artifacts (ignored, not publication payload):
`remote-im-b9ee33ac-acceptance.json`,
`remote-im-gui-final-20261104/live-gui.json`,
`remote-im-recovery-final.json`, and `remote-im-hub-final.log`, under
`.dsh-test-tools/`. Browser screenshots beside the GUI evidence show pairing,
IP chooser, @all completion, member permissions, Human rename, non-chat offline
feedback and recovered messages. They contain synthetic identities only.

The remove-then-immediately-@all scenario initially exposed an outdated member
projection. The fix awaits a current membership snapshot, fails closed while
unavailable and prevents older responses replacing newer versions. The final CLI
run passed this scenario and original-intent retries after removal/rename.

## Desktop regression limitation

The app full regression naturally finished in 5.43 seconds: **232 tests,
227 pass, 4 fail, 1 skip**. This is not a green app suite. Remaining failures are
unchanged Windows junction/symlink tests in import.test.mjs and move-data.test.mjs:
ENOTEMPTY during temporary-directory cleanup and expected EPERM versus ENOENT
for a dangling link. These do not exercise the changed CLI unpack configuration.

One pre-existing bot-views test cleanup hung the original full run by leaving a
WebSocket open after removing a junction target too early. Its test-only cleanup
now unlinks the junction first and releases socket/manager in finally; that file
passes **21/21** and exits naturally. No production desktop behavior was changed.
Local diagnostic: `.dsh-test-tools/remote-im-app-hang-diagnosis.json` and
`remote-im-app-final-repaired.log`.

## Deployment boundary

Actual physical cross-machine WSS, certificate trust and network/firewall routing
remain NOT RUN. This is an implementation and local Mock acceptance, not a claim
of deployed two-machine acceptance. Use Add a device / setup-guide with operator
approved credentials, preserve the full Hub peer list and stable IDs, verify exact
contacts at both ends, then test synthetic DMs/groups and intended speech modes.
The implementation does not install services, certificates or firewall rules.

## Final source regression

- Plugin full suite: **1534 total, 1532 pass, 2 pre-existing skips, 0 failures**.
  This includes the final Memory/workspace tests and the esbuild-dependent Bot
  settings test that could not spawn in the restricted targeted run.
- Generated client build and freshness check: passed. Lint: exit 0, existing
  warnings retained.
- New CLI/prompt/isolation tests: **26/26 passed**; two packaged Skills validate.
  Actual npm pack and isolated offline install successfully execute both
  dsbot-remote setup-guide and dsbot-team memory-capacity (main 10000).
- Six targeted Memory/workspace tests pass, including 10000/10001 Chinese/emoji
  boundaries for own/team/group memory, saved-workspace restart, protected paths,
  non-Main cross-Bot rejection, and revocation during asynchronous approval/checks.
- Exact staged publication tree secret/privacy scan: **0 must-fix findings**.
  The 628 informational matches are vendor/model names, compatible legacy names,
  synthetic email-like mention fixtures, numeric icon-path matches and code path
  references. No credentials, encrypted vaults, databases, runtime logs, test
  profiles or screenshots are staged.

Native local-team Mock smoke also passed all 52 steps, including Bot/group
creation, Memory isolation, conversation condensation, Main-role changes and
attached capability isolation. Its isolated bench was stopped in finally;
acceptance/GUI/recovery benches were also checked to have released their ports.
Local normalized transcript: `.dsh-test-tools/remote-im-native-smoke-final.json`.
