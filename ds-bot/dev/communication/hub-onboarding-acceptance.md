# Hub onboarding and avatar acceptance

Run `node ds-bot/dev/communication/hub-onboarding-acceptance.mjs --enroll-only`
for the minimum real enrollment smoke test. It starts a management Hub with no
legacy peers and two genuinely fresh unconfigured DSH profiles, on same-machine
loopback ports 3185/3186, 8885/8886 and 3194. Each profile decodes the public Hub
code, submits a signed join using its own DSH SDK credential record, receives an
HTTP administrator approval using session cookie plus CSRF, then configures and
connects through the normal configuration-editor reload and signing SDK.

Omit `--enroll-only` for the full scenario. It explicitly publishes the selected
local Chiefs, exchanges scoped user-code contact requests and acceptance, then
checks mutual visibility, real DSH DM/group/reply sources and one-response grants.
Contact revocation hides the friend directory but leaves the independent group
authorized. Re-consent rotates DM epochs; an old queued message must fail instead
of publishing. Human avatar image/reset/name and local Bot look updates propagate
through authorized reads. A readOnly member can read member information but cannot
save settings. Unpublishing removes the Bot from the directory and future `@all`
AI recipients while retaining its historical member identity as `published:false`.

Rejection/expiration, administrator revoke/repair, rate limiting and signature
replay/forgery require separate unit evidence and are not claimed as real DSH
coverage by this script. The minimum mode does not claim the full scenario passed.

The script never calls LocalTopology.initialize or pre-creates a legacy identity.
Its internal `DSBOT_COMMUNICATION_ONBOARDING_FIXTURE=1` flag creates the initial
Bot checkRatio in the fresh ordinary profile patch, once before boot, instead of
an external command-line overlay. The official Config Editor correctly refuses
edits hidden by such an overlay; that guard remains intact. A marker prevents
re-initializing or overwriting the SDK's later edits. Existing bench defaults are
unchanged, and the fixture refuses to replace an existing profile configuration.
No credentials, administrator password, session cookies, signing key material or
user codes are logged or stored in evidence. Secrets are generated only for this
run. By default, after stopping owned processes and checking all ports are free,
the script deletes its exact fresh profile directories, including temporary SDK
signing-key records and launch logs. `--keep-profiles` explicitly retains those
private profiles for local diagnosis; do not publish them.

The Hub database and sanitized JSON evidence remain under `.dsh-test-tools`.
The administrator password is process-memory-only; the Hub stores public signing
keys, not client private keys. No real user profile, real key, external model,
SSH, VirtualInput or non-loopback network request is used. The twelve-minute
deadline, host/Mock owner-PID watchdogs and Hub IPC ownership bound the run.

`--live-for-browser` is an explicit optional GUI fixture. After its selected
acceptance scope passes, it keeps the owned hosts and Hub alive until the private
stop file is created or twelve minutes pass. Its ready JSON contains public URLs,
Hub code and principal IDs only; never cookies, launch tokens or signing keys.
Browser pages are opened separately through the GUI test tool; the fixture keeps
normal DSH no-open behavior. Only this opt-in fixture uses the public synthetic
admin password `mock-only-hub-admin-browser-pass-20261104`;
it is not a real credential and becomes unusable when the isolated Hub stops.
The same finally cleanup then stops owned processes and deletes temporary SDK
records by default. Combining `--enroll-only --live-for-browser` starts a smaller
fixture without claiming the full consent/avatar scenario passed.

Recorded full validation: `hub-onboard-79b6eede-acceptance.json` under
`.dsh-test-tools` passed all six cases against real DSH A/B and the loopback Hub.
The revocation case retains a pending DM under a publication capacity fault while
checking the same sender's directory refresh and shared-group AI delivery; it
does not bypass the blocked sender by sending through the other instance.
GUI fixture readiness is separate from cleanup: check `cleanedUp` and
`temporaryKeysDeleted` in the final evidence after the stop file or expiry.
