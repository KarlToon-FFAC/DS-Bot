# Isolated communication API bench

## Cross-platform launcher

`node dev/communication/bench.mjs start|stop|status <name> <web-port> <mock-port>`
preserves the existing `bench.ps1` path on Windows and uses a dedicated Node
supervisor on Linux. `LocalTopology` selects this launcher automatically. Other
platforms currently fail explicitly. Linux requires the standard util-linux
`/usr/bin/flock` command and does not require PowerShell.

For a separate Mock-only cloud rehearsal, run in `ds-bot/` after `npm ci`,
`npm run harness`, and `npm ci --prefix ../communication-hub`:

```sh
node dev/communication/bench.mjs start cloud-smoke 3131 8831
node dev/communication/bench.mjs status cloud-smoke 3131 8831
node dev/communication/bench.mjs stop cloud-smoke 3131 8831
```

Linux writes only `.dsh-test-<name>/`, retains data on stop, and identifies owned
processes by executable, script, scope and Linux process birth time. A dedicated
supervisor stops both workers on owner loss, child loss or the bounded lifetime.
An OS-held lock prevents concurrent starters from sharing one test home, including
after a stale manifest or an interrupted run. Lock files are retained rather than
unlinked, avoiding inode-replacement races. It does not stop unrelated Node
processes. Child environments contain only the
required runtime and synthetic fixture settings; ambient provider credentials
and Node preload options are not inherited. The Mock never receives pairing or
OpenAI guard credentials. Launch tokens remain in the private isolated log.

This prepares local Linux execution only. Windows DPAPI records are not imported.
Do not reset or copy completed real-test ledgers, run an old real pilot again,
or put an API key in chat, source, arguments or a profile. A future cloud real
run still needs a supported secure input channel, a newly authorized run/budget,
current price verification and official OpenAI network access. The production
model remains exactly `gpt-6-luna`; ordinary benches remain Mock-only.

The cloud preparation synchronizes the test guard with the current scoped
communication tools added since its earlier pilot. A Linux full-chain Mock run
passed seven checks with six loopback requests and no external model calls.
This verifies the Linux DSH/Hub chain with synthetic responses, not real-model
behavior, different-machine networking or native Windows application behavior.

## Native Windows bench and prior acceptance

This bench includes P0–P4 production acceptance and the subsequent group-policy
and privacy tests. They run real independent DSH Web hosts and deterministic
loopback Mock models. The independent `communication-hub/` package provides the
durable authenticated transport; production communication remains disabled by
default in DS-Bot.

After installing the dependencies below and `npm ci` in `communication-hub/`, run
`node dev/communication/adapter.mjs`. It starts its owned A/B hosts and Hub,
generates pairing credentials only in memory, verifies all four DM directions,
same-name identities, exact admission/export mappings, forced host crashes,
automatic Session rotation, private-chat isolation and offline target recovery.
It stops its own processes in `finally` and retains test data. The sanitized
result is `.dsh-test-tools/p2-adapter.json` at the repository root. It expects the
P0 `communication-a` and `communication-b` profiles initialized by the commands
below; never use a real user's profile.

`node dev/communication/group-demo.mjs` verifies production mixed-group routing,
invitations, same-name identities, authorization and canonical history agreement.
Add `--hold` to keep the owned Hub/A/B hosts running for a browser demonstration.
It uses DSH's documented normal startup browser opening; startup credentials are
never copied into chat. The two pages are `http://127.0.0.1:3101/` and
`http://127.0.0.1:3102/`. Stop the held demo by creating the repository-root file
`.dsh-test-tools/p3-stop`; there is also a 30-minute maximum. No persistent service
or pairing credential is installed. Results: `.dsh-test-tools/p3-group.json`.

The production sidebar's **Communication** entry is separate from the original
private chats. Human membership is required to read a conversation; owning a Bot
that participates does not grant the Human that Bot's DM history. Group invitations
for an explicitly published local Bot can be accepted by its local owner.
Use the exact participant picker for same-name Chiefs. Text/Markdown and authorized
same-conversation reply references are supported; attachments are rejected.

P0–P4 local acceptance and the added governance browser matrix have passed. See
the repository's `docs/plans/federated-communication/p4-acceptance.md` and
`group-governance-evidence.json`. Browser checks include create/invite/accept,
exact mentions, references and restricted placeholders, rejoin boundaries,
long-body rendering, paging, close/restore, leave/end and offline recovery.
The original responsive checks used a same-origin 508/700/1024px production
iframe. Final review also verified actual Chrome viewport overrides at those
widths, restored the override and checked stable Bot-final errors and owner/admin
controls. See `docs/plans/federated-communication/final-security-review.md` at the
repository root. Native OS window manipulation, different-IP, WSS runtime and
real models were NOT_RUN in that historical snapshot. Subsequent tests verify
local WSS certificate/authentication behavior and real OpenAI through independent
DSH/Hub processes on this computer. See the final pre-push review and
`docs/plans/federated-communication/two-machine-trial.md` for current coverage,
startup and rollback. Different-IP and native packaged Electron acceptance remain
NOT_RUN. The normal desktop provider configuration is separate from the isolated
OpenAI vault test launcher.

## Encrypted OpenAI reuse and real-chain acceptance

The newly entered key is saved as DPAPI CurrentUser ciphertext outside Git.
The full same-computer production DSH/Hub chain has passed with real `gpt-6-luna`:
six official requests, seven checks, crash recovery with no regeneration and no
private-Chief wakeup. See [current storage/use/rotate/delete instructions and evidence](../../../docs/plans/federated-communication/openai-encrypted-reuse.md).
Use `openai-vault.ps1 -Action Status` for metadata, `Verify` for decryptability,
`Rotate` for hidden replacement input, and `Delete -ConfirmDelete` for explicit
local removal. `RunFederation` uses the saved key; the completed run refuses
silent re-entry. Normal test benches remain Mock-only and no personal DSH profile
was changed. Earlier preparation paragraphs below are historical snapshots.

Latest: the explicitly authorized real provider pilot has completed successfully
with seven official requests and three synthetic prompt probes. See
[the result and exact scope](../../../docs/plans/federated-communication/openai-real-pilot.md).
The fixed entry is `openai-private-input.ps1 -RunOnce`; do not repeat the completed
run or reset its ledger. Use `-Mock` for a complete no-key loopback rehearsal.
The ordinary configuration template remains disabled. The paragraphs below are
historical preparation details, superseded by the latest result where stated.

Private native input rehearsal is now implemented; see
[the exact one-command procedure and current limitations](../../../docs/plans/federated-communication/openai-private-input.md).
It has been verified with synthetic values on Windows PowerShell 5.1 and 7,
including the interactive hidden prompt. It cannot make API calls and discards
the input before exiting; do not ask the user to enter a real key into it now.

The latest optional real-model proposal uses the official OpenAI Responses API
with exact model `gpt-6-luna`. No real account or API request has been exercised.
See [the bounded plan](../../../docs/plans/federated-communication/openai-model-preparation.md)
and [preparation evidence](../../../docs/plans/federated-communication/openai-preparation-evidence.json).
`openai-test.config.example.json` is a preparation schema, not a DSH profile;
`execute: false` and a zero money budget keep it closed. No key is needed to run:

```powershell
# Run in ds-bot; Node workers require the normal test execution permission.
node --test test/openai-budget.test.js
# Public installed Pi adapter + official SDK -> local guard -> in-memory Mock:
Push-Location dev/harness
node --input-type=module -e "import { stream } from '@earendil-works/pi-ai/api/openai-responses'; import { checkOpenAIWire } from '../communication/openai-wire-check.mjs'; console.log(JSON.stringify(await checkOpenAIWire(stream)))"
Pop-Location
```

The guard module exports `OpenAIBudget`, `OpenAITestGate`,
`officialOpenAISender` and `startOpenAITestGuard`; it has no auto-start or ambient
credential discovery. The wire fixture imports only the public adapter supplied
by the caller and closes its ephemeral listener. Real execution needs a separate
authorized single-run launcher. Never paste an API key into chat, put it in a
profile/config file, or substitute the default user's DSH_HOME.

## Final local matrices

Run in `ds-bot/` after the dependency setup below. Each non-held script stops
only its recorded test processes in `finally`, retains data and bounds each wait.
Recovery and behavior share `p4-a/b`; do not run them concurrently. Network uses
separate `p4net-a/b` profiles and ports.

```powershell
$env:DSBOT_TEST_RUN_ID = 'run-20261103-1' # choose a new value for each full run
node dev/communication/recovery-matrix.mjs   # 7 real-host crash windows
node dev/communication/network-matrix.mjs    # 8 independent-Hub network windows
node dev/communication/behavior-matrix.mjs   # 11 communication/authorization cases
node dev/communication/atomic-matrix.mjs     # 2 native transaction deaths
node dev/communication/governance.mjs        # 9 dual-host policy/privacy cases
node dev/communication/governance.mjs --hold # normal authenticated browser opening
```

`DSBOT_TEST_RUN_ID` appends a validated suffix to LocalTopology profile and Hub
database names. Use a fresh value for repeated acceptance runs: membership
history is intentionally retained and counts toward the bounded per-instance
capacity. No reset or deletion is needed. Ports stay fixed, so matrices sharing
ports must still run sequentially. Clear the variable after running if desired.
Profiles and logs live at the repository root, not under `ds-bot/`.

Governance initializes `.dsh-test-governance2-a/b`: Web 3107/3108, Mock 8807/8808,
Hub 3194. Its held browser phase uses normal DSH startup login and stops after
at most 20 minutes. Create repository-root `.dsh-test-tools/governance-stop` to
stop sooner. No real account/key or persistent pairing credential is needed.
Results: `.dsh-test-tools/governance.json` and `p4-{recovery,network,behavior,atomic}.json`.

New invitees default to Human read-only / Bot reply-only. The original behavior
matrices explicitly grant speaking rights before exercising active members.
Hub schema v2 retains v1 speakers. The required `group-policy` handshake capability
refuses older clients explicitly. `ui-seed.mjs` only seeds a disposable
`UI acceptance ...` group; it is not a production migration command.

Use Node 24 and PowerShell on Windows. In `ds-bot/`, install the existing pinned
test harness and build tools:

```powershell
npm.cmd ci --registry https://registry.npmjs.org --offline=false --cache ../.dsh-test-tools/npm-cache --no-audit --no-fund
npm.cmd --registry https://registry.npmjs.org --offline=false --cache ../.dsh-test-tools/npm-cache run harness
npm.cmd run build
node dev/communication/build-probe.mjs
```

The bench uses the public `@deepseek-ai/dsh/profile-boot` entry point and
`loadProfileDirectory`, as the desktop app does. Its install anchor is the pinned
`dev/harness/package.json`; local junctions link the two development bundles.
It does not need another DSH checkout to be built or a global pnpm installation.
The optional ignored `deepseek-harness/` source checkout is for API documentation
inspection only. No files in that checkout are patched.

Start the benches (all commands below run in `ds-bot/`):

```powershell
./dev/communication/bench.ps1 start -Name communication-a -WebPort 3101 -MockPort 8801
./dev/communication/bench.ps1 start -Name communication-b -WebPort 3102 -MockPort 8802
node dev/communication/verify.mjs initial
```

Only loopback is bound. Each bench has its own data, profile, workspace, actual
Chief and port-scoped browser login. Data lives in the repository root under
`.dsh-test-communication-a/` and `.dsh-test-communication-b/`. Test-only instance
and Human IDs are persisted by the probe; Bot IDs refer to each real local Chief.
Each communication probe binding uses separate ordinary DSH Sessions, without
merging the Chief's existing private chat. The separate production adapter is
enabled only by explicit `bot.config.communication` settings.

The complete login URL is in each local `web.log`. Do not share or commit it,
the logs, cookies or data directories. The CLI prints only the address without
the token. The bench disables both session contribution and OTel export and
configures only the existing Mock placeholder key at the loopback model URL.

Check status, force-stop the owned processes, then restart with the same data:

```powershell
./dev/communication/bench.ps1 status -Name communication-a
./dev/communication/bench.ps1 status -Name communication-b
./dev/communication/bench.ps1 stop -Name communication-a
./dev/communication/bench.ps1 stop -Name communication-b
./dev/communication/bench.ps1 start -Name communication-a -WebPort 3101 -MockPort 8801
./dev/communication/bench.ps1 start -Name communication-b -WebPort 3102 -MockPort 8802
node dev/communication/verify.mjs recovery
./dev/communication/bench.ps1 stop -Name communication-a
./dev/communication/bench.ps1 stop -Name communication-b
```

Stopping checks the recorded PID, process creation time, executable and script
path before terminating a process. It retains data for recovery and never stops
processes by name. On Windows this is a forced process termination, intentionally
testing process-loss recovery rather than claiming graceful DSH shutdown.
Port conflicts fail before startup. Failed startup stops only the processes it
has just created. There is no automatic data-reset operation.

The probe result is `.dsh-test-tools/p0-probe.json`. It records synthetic test
identities, source IDs and output identities, and contains no authentication
material. `initial` uses a fresh nonce so it can be repeated without deleting
old data. `recovery` compares the most recent successful initial run with cold
public inspection after both hosts restart. It must not cause any new model
calls. This proves the recorded queued/admitted inputs and persisted final output
survive the tested restart; it does not cover every mid-call crash window.

Run the existing host smoke with a separate fresh name and its expected ports:

```powershell
./dev/communication/bench.ps1 start -Name smoke -WebPort 3096 -MockPort 8796
node dev/smoke.mjs smoke 3096
./dev/communication/bench.ps1 stop -Name smoke
```

The existing smoke expects fresh data. Use a new bench name on another run, and
pass that same name to `smoke.mjs`; do not reset an existing user's profile.

## Historical P0 API probes

`createUserMessage` preserves producer source fields. `followup`, `steer` and
`Agent.inbox` are public admission paths; `sessions.flush` is the durability
barrier. `sessionController.inspect` can read attached and cold Sessions without
starting model work. No deprecated synchronous Session readers or internal
plugin-record APIs are used.

`src/host/federation/session-journal.js` reconciles exact source IDs, folds pending
inbox splices and extracts completed final text with stable source keys across
all retained binding segments. Reasoning, tool calls, interrupted drafts and
unfinished turns are not exported. The caller must atomically persist source
mapping, complete outbox and export cursor before sending; the production
`CommunicationQueue.commitExports` implements that transaction. `absent` is an observation, not automatic permission
to retry an in-flight call. A claim with no proven admission is explicitly
`injection_unknown` during a live call. `recoverBinding` obtains the public
Session writer, requires an idle owner, flushes and inspects the complete repaired
log before classifying a claimed-but-unadmitted input as `not_admitted`.
`completedOutputs(..., { recoverSettled: true })` can recover an already settled
final `stop` response from a turn interrupted after output persistence. It does
not export cutoff drafts or regenerate a reply.

Additional real-host checks (stop B first; each script owns and stops its B bench):

```powershell
node dev/communication/faults.mjs
# With A running, project B's actual persisted Mock reply into A's Human view:
node dev/communication/human.mjs
# Recover an ordinary followup queued before process loss:
node dev/communication/queued-recovery.mjs
node dev/communication/build-probe.mjs --check
```

`faults.mjs` suspends at awaited public `pre-step` and `turn-stopping` hooks,
flushes, kills and restarts the real host, and verifies exact-source input
recovery or original-output recovery. A live suspended Agent is denied a replay
grant. `human.mjs` feeds the real persisted B output into test-only group/DM Human
projections, checks author, unread/read and duplicate handling, and verifies A's
Chief log and model-call count do not change. This proves an adapter boundary;
there is still no Hub transport or production Human adapter.

`queued-recovery.mjs` first reproduces the idle-restored pending-input boundary:
a normal `followup` queued while the first turn is held survives restart but
remains pending on an idle Agent. Resubmitting the same identified message is
rejected; public QueueDock steer requires a running Agent. No wake-only method
was found in the documented public Agent interface. It then calls the production
`resumePendingInput` helper: a truthful host-restart notice with a distinct
producer source is sent through public `agent.steer`. The original pending
input is consumed with the same DSH ID, one model call and no retransmission.
Retry and a second restart add no calls. The accepted input is never removed or
reinserted; no Human message is impersonated, private method invoked or DSH
patched. See [the recovery evidence](../../../docs/plans/federated-communication/p0-recovery-gap.md).

The test-only client registers the public `main` and sidebar slots. Actual
DS-Bot covers the framework's ordinary navigation, so the visible test entry
and pane use public `shell.overlay` with a standard ReactDOM portal, as existing
DS-Bot UI does. Its own focus boundary contains late underlying-composer focus
restoration after refresh. No DSH CSS class or private state is changed.
It has two Human projection views and its own
composer; it is not a complete federation UI. Browser login uses the isolated
DSH's existing launch URL, not a real DeepSeek account. Never paste that URL or
its token into chat. React/JSDOM interaction tests cover draft isolation and
Enter propagation; actual authenticated browser focus, switching and refresh
checks are now verified in real Chrome, with unchanged Chief events, zero UI
model calls and no duplicate sends across refresh. This proves the P0 boundary,
not final production navigation or Hub transport.

The P0 probe alone does not validate production transport. The adapters, Hub,
queues, production UI and complete local acceptance are covered by the later
scripts above. Different-IP networking, WSS and real models are separate unrun scopes.
