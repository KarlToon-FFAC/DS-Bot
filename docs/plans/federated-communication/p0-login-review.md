# P0 login boundary and original recovery requirements

## Current result: browser gate passed

The user opened the normal startup URL in Chrome. Its authenticated A tab showed
the real Chief and the public probe status, and was claimed for testing. No
additional real account, key, authentication provider or credential grant was
needed. Existing browser authentication also survived the tested A host restart.
P0 browser navigation, separate drafts, Enter isolation, refresh/history, correct
Human projection and late-focus containment now pass. Chief events stayed at
five and these UI operations made zero model calls. See `p0-followup-evidence.json`.
The earlier queued-panel and application-control sections below are historical.

The complete Windows log path is:

```text
D:\git\DS-Bot-federated\.dsh-test-communication-a\web.log
```

Use `D:/git/DS-Bot-federated/.dsh-test-communication-a/web.log` in prose. Earlier
parent messages put the Windows path in ordinary Markdown text. Its `\.` before
the test directory is a Markdown escape, so the displayed path can lose that
separator and concatenate the repository name and test-directory name. The raw
message history contains the complete path; the rendered task accessibility text
showed the concatenated form. This explains a real transmission error without
inventing a different on-disk location. See the [CommonMark escape rule](https://spec.commonmark.org/0.31.2/#backslash-escapes).
The earlier suggestion that sorting/Git-ignore alone explained the user's
failure to locate it was insufficient and is corrected here. Native Explorer
and terminal both resolve the same root-level directory, not `ds-bot/`; both run
as Administrator in session 1 and no path component is a reparse point.

Future opening of this task's pages is authorized. Reuse the authenticated Chrome
tab and normal startup flow; do not ask the user to repeat an already completed
login. Never render a credential-bearing log or URL in a report or screenshot.

## Login finding

No GitHub, DeepSeek, ChatGPT or real-model account login is required for these
tests. All model calls use the repository's loopback Mock. The automated real
DSH API tests already authenticate through the isolated host's normal launch
URL, keep the resulting cookie in process memory and disclose no token.

The remaining browser test uses **http://127.0.0.1:3101** (A), with B at
**http://127.0.0.1:3102** if needed. Bare root without its browser cookie returns
`dsh web authentication required; reopen the URL printed by dsh web.` There is
no account/password form. The standard startup URL includes a per-process
random launch token. Opening that exact URL performs the stock cookie exchange
and redirects to a clean root URL. Do not paste the launch URL into chat.

Only this repository's `.dsh-test-communication-a/web.log` is used to obtain A's
current startup URL; no user credential files are inspected. Restarting the
host invalidates the previous launch token. The stock browser-cookie signing
grant already exists in the isolated profile. No additional authentication
provider, permission, persistent credential or security setting was introduced.
The normal browser flow itself is not fully nonpersistent: stock DSH stores its
signing grant, and its browser cookie defaults to 30 days. The public
`cookieMaxAgeDays` setting has a one-day minimum; a session-only configuration
must not be invented. The test API caller's memory cookie is not installed into
the browser or substituted for normal browser login.

The previous `open_in_codex` result was `queued` for this hidden delegated task.
This is the app-panel dispatch step **before** browser navigation, not a DSH
login rejection, permission dialog or model authentication failure. A fresh
browser inventory subsequently contained no tabs. The earlier queued URL belongs
to a stopped process and must not be used as evidence of successful login.

The agent also tried obtaining the native ChatGPT window (ID 530380) to select
the local task itself. The computer-use tool displayed `Allow Codex to use
ChatGPT?` and timed out awaiting app-control approval. No navigation executed.
The visible user history contains no approval of that specific prompt, so the
action was not retried. This is an app-control authorization timeout, not a DSH
credential failure or an automatic safety-review rejection. If the user grants
that exact app-control permission, the agent can retry the unexecuted selection
once; alternatively the user can select the DS-Bot local task directly.

Update after explicit user authorization: application control succeeded without
a new approval card or ID. The minimized window was restored through supported
`launch_app`, and the exact DS-Bot task was selected. No other task was opened.
However secure launch dispatch still returned `queued`, including when targeting
the observed browser tab. The actual tab at A's bare root remains unauthenticated.
There is no pending tool or OS permission dialog. This supersedes the earlier
app-control approval blocker; the remaining boundary is launch navigation.

A is temporarily running for this local browser-authentication handoff (Web PID
16092, Mock PID 18044; ports 3101/8801). B and smoke remain stopped. The user may
open the current A startup address from the exact isolated `web.log` locally in
the DS-Bot task browser; no password/key or sharing the token is needed. Stop A
with the command below once the browser test or handoff is finished. This is a
temporary test process, not an installed service.

To continue browser acceptance, show this local DS-Bot development task in the
Codex app on 88. Then the agent can start A, submit its fresh launch URL to that
task's browser panel without printing it, verify the authenticated DS-Bot shell
and run focus/navigation/switching/refresh checks. The only human operation, if
the panel remains hidden, is selecting this task; no password, API key or new
access grant is needed. Do not ask the user to identify an unspecified login
page. Benches are stopped after use; obtain a fresh launch URL after restarting.

```powershell
cd D:/git/DS-Bot-federated/ds-bot
./dev/communication/bench.ps1 start -Name communication-a -WebPort 3101 -MockPort 8801
./dev/communication/bench.ps1 status -Name communication-a
# Agent opens the current isolated launch URL securely, then performs UI checks.
./dev/communication/bench.ps1 stop -Name communication-a
```

## Original plan gates and allowed recovery

The handoff orders environment/baseline, two real isolated DSH instances and
Mock, **P0 first**, then P1 Hub/local durable queues, P2 exact Human/Bot adapters,
P3 communication UI, and P4 fault/full acceptance. It explicitly permits a new
implementation branch from the requested docs branch; that is why
`chore/federated-communication` was created without replacing the user's baseline.

P0 requires writable independent Chiefs; stable instance/Human/Bot identities
including equal display names; conversation/Bot-to-Session bindings across
segments; durable source IDs through public message/steer/followup/flush;
recoverable persisted final outputs; projections that do not trigger a model;
Bot-to-Human notifications that do not feed the recipient's Bot; actual overlay,
navigation, focus, switching, refresh and hidden-composer Enter checks; and an
explicit boundary between old local DM and new communication DM.

Its required conclusions are identity isolation, conversation isolation, correct
Human receipt, input/output crash reconciliation and replay without new delivery.
Implementation plan section 4 forbids solving an API gap by modifying the DSH
kernel, directly editing its logs or invoking forbidden internal APIs. This
requirement does **not** force an upstream change when a public API path works.

Protocol section 13 requires intent/source persistence before admission and the
actual DSH mapping after admission. On recovery, query by original source:
confirmed existence repairs the mapping without replay; confirmed absence can
restore the original delivery; uncertainty stays `injection_unknown` and blocks
blind retry. Output source mapping, complete outbox and export cursor must be
atomic, including recovery from old segments; unavailable durable output is
`export_unknown`. Those transactional stores are not implemented by the P0 probe.

Acceptance section 6.1 explicitly rejects leaving an input permanently unknown,
requiring user resend or silently skipping it as no-message-loss acceptance.
Evidence must show original IDs, the correct Session, one expected consumption
and one visible reply. This does not promise exactly-once external tool effects.
Explicit invalid protocol, authorization, revoked delivery and unsupported
content failures may have visible terminal errors. Ordinary accepted pending
input after restart cannot be declared failed merely to waive eventual recovery.

The minimum local recovery fix now verified is `resumePendingInput` plus the
real crash probe and unit cases. Its lifecycle notice truthfully describes the
restart, has a distinct host producer source, and wakes the original pending
identity via public `agent.steer`. It does not require an upstream patch or a
user decision about upgrading DSH. Real-browser acceptance is still required
before dependent Hub work starts.
