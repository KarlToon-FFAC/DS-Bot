# Fresh Remote Hub enable

2026-11-10. Keep V0.3.1 and the existing communication protocol.

Enabling Remote Hub before enrollment is a local UI preference. It must not
require a Hub address, credential, publication, connection or DSH profile edit.

## Functional defect and correction

The original implementation asked ConfigEditor to rewrite the complete plugin
configuration merely to expose setup. A home/command-line configuration override
could consequently prevent a fresh user from enabling the feature. The initial
error-mapping correction identified that save rejection accurately but left the
functional dependency in place.

For an unconfigured profile, persist `prefs.remoteHubSetupEnabled` using the
existing DS Bot team state writer with `required: true`. This storage already
handles the local writer lock and Windows file-replacement contention. The
feature remains at its previous value until the write succeeds. Failed saves
restore the old preference; stale versions, read-only hosts and stopped runtimes
cannot change it. Success takes effect immediately without reloading DSH, and
normal state reads load the saved preference before enforcing entry gates.
There is no profile editor call, connection, automatic enrollment, Bot
publication or model turn. An initial explicit off default can be opted into by
the local user without rewriting that profile default.

The local path applies only before any Hub is configured, with no active
communication configuration, retained Bot publications or pending withdrawal.
Approved first enrollment and Hub selection promote an enabled local preference
to the explicit profile flag. A configured Hub ignores the setup preference and
continues to use the existing profile transaction for disable, publication
retirement/generation rotation, durable withdrawal and re-enable. A stale local
setup preference cannot revive a disabled Hub or resume retired Bots.
First selection/approval writes share the local control's serial queue and copy
the current opt-in or opt-out only while the profile is still unconfigured. A
late approval cannot undo a committed local disable. A configured Hub ignores
both stale setup opt-ins and stale setup opt-outs on later resume/selection.
Promotion also records `remoteHubProfileManaged` in the same profile transaction.
Removing/resetting Hub data later therefore cannot revive a stale setup opt-in
over an explicit profile disable.

This uses DS Bot's own state and public DSH APIs. Configuration ownership rules
remain enforced when actually configuring the Hub. Exact ConfigEditor failure
mapping remains useful for those operations; arbitrary private exception text
is never exposed. No DSH code or real user files are patched.

## Verification

`node ds-bot/dev/communication/remote-hub-enable-acceptance.mjs` starts a fresh
owned native DSH profile with deterministic Mock and no Hub. It verifies default
off, immediate enable, disable, enable with a real command-line Bot config
override, byte-for-byte unchanged profile configuration, and persistence through
restart with that same override. All three cases pass.

`node ds-bot/dev/communication/hub-onboarding-acceptance.mjs --scoped-ca --enroll-only --remote-hub-switch`
uses two owned native DSH instances and a real local Hub. It verifies the local
opt-in, v2 scoped-CA enrollment, administrator approval, signed connection,
publication, paused-credential withdrawal, restart off and empty-publication
resume. Both integrated cases pass.

Unit coverage includes required-save commit visibility, rollback, stale version,
read-only ownership, no ConfigEditor, explicit initial off, cold API startup,
first approval promotion and an explicit configured disable winning over a stale
setup preference. Existing configured-Hub withdrawal tests remain unchanged.
Full plugin tests, generated-client freshness, lint and native 52-step smoke are
also checked. Tests use synthetic Linux profiles; Windows deployment remains a
separate validation environment. All owned processes are stopped after testing.

Final plugin results: 2,102 tests, 2,097 passed, five skipped, zero failed.
The focused control/enrollment regressions pass all 44 tests. Native local setup
passes all three cases, scoped-CA enrollment/withdrawal passes both integrated
cases, and local-team Mock smoke passes all 52 steps. Lint and generated-client
freshness pass; existing unrelated lint warnings remain.
