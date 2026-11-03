# Local implementation record

## Latest encrypted reuse and full real chain (2026-11-03)

The owner approved persistent DPAPI CurrentUser storage and supplied a new key
locally. The save failure was fixed and the encrypted record is configured and
decryptable without exposing its value. Full real DSH/Hub local acceptance passed
all seven checks with six official requests, 6466 input / 22 output tokens and
a conservative modeled generation-token estimate of $0.0016275. Crash export
recovery and repeated restart added zero requests; the original private Chief
stayed unchanged. The earlier separate temporary-key pilot used seven requests;
cumulative total is thirteen across the two authorized runs, with both ledgers
retained. See [the current instructions and scope](openai-encrypted-reuse.md).
Final regression: 1491 tests, 1489 pass, two original skips; final full Mock chain,
lint and bundle freshness passed. Owned A/B processes/ports are stopped; only the
approved encrypted record persists. Earlier design-only/NOT_RUN snapshots below
are superseded for this precise scope, not for different-machine validation.

## Latest actual OpenAI provider result (2026-11-03)

PASS_OPENAI_PROVIDER_PILOT: official `gpt-6-luna`, seven actual requests
(one visibility, three counts, three generations), all three synthetic prompt
probes passed. Usage: 2195 input / 29 output tokens; conservative modeled token
cost upper estimate $0.00056325, not an invoice. No credential saved. The owned
input window and model worker are finished. See [scope and evidence](openai-real-pilot.md).
This narrow direct-Responses provider pilot does not replace the real-model
DSH/Hub or real different-machine tests, which remain unrun. The later encrypted
reuse request is [design only](openai-credential-storage-proposal.md), with no
persistent record created. Earlier NOT_RUN/input-only entries are snapshots.

## Latest private-input preparation (2026-11-03)

The owner authorized temporary key use for official OpenAI, synthetic tests,
at most eight outbound requests and a $5 account ceiling. No real key was
forwarded or read here. Native hidden input and private child-environment
transport passed with synthetic values on Windows PowerShell 5.1 and 7. The
input-only worker discards the value and exits; it cannot stage a later test or
make a request. See [the procedure](openai-private-input.md) and its separate
evidence. Actual calls remain zero. Strict final-account-bill enforcement at $5
cannot be guaranteed, including by the provider's delayed hard-limit controls;
no billing settings, persistent credentials or account permissions were changed.

## Latest optional OpenAI preparation (2026-11-03)

The user selected official OpenAI GPT-6 Luna. Its verified API ID is
`gpt-6-luna`; no `gpt-5.6-luna` substitution was made. The development-only
budget guard and safe disabled configuration now pass 12 focused Mock tests
and a separate public Pi/official SDK loopback streaming check. Full regression:
1481 total, 1479 pass, 2 existing skips; lint and bundle freshness pass. Production
package contents are unchanged from the final federation review below.
See [the current plan](openai-model-preparation.md) and
[new evidence](openai-preparation-evidence.json). Real/account/token-count API
requests remain zero, no key was read, and spending/account access remain
unapproved/unverified. This checkpoint supplements the earlier federation
review; it does not claim additional real-model or different-machine coverage.

## 最新独立安全复核检查点（2026-11-03T10:23:19.668Z）

已修复独立审查及二次复核的问题，见 [最终安全复核](final-security-review.md) 与 [机器可读证据](final-review-evidence.json)。插件 1469 项：1467 通过、2 原有跳过；35 项通信专项（其中 8 项最终安全回归）及另 1 项本地提示回归。Hub 31/31；原生治理/隐私 9、恢复 7、网络 8、行为 11、事务崩溃 2、原有 smoke 52 全通过。最终实际 Chrome 508/700/1024px 视口、群主/管理员和失败提示复验通过；没有导出离线截图文件。安装包干净安装且所有文件哈希一致。测试进程/端口已清理，数据保留，DSH 源码与 VirtualInput 未改动。

实现分支和用户指定 docs 基线保留，所有更改未提交、未推送。真实模型为 NOT_RUN：隔离配置只有 Mock，当前进程无真实 API key 引用；个人凭据区未检查。后续真实模型需要确定凭据来源与调用预算，见 [具体试验提案](real-model-test-plan.md)。下面所有旧统计、BLOCKED、待登录及“未实现”描述均为历史快照，不代表此检查点。


## 权限功能初次交付检查点（安全复核前快照）

P0–P4 先完成后，用户追加的群主/管理员、Human 只读/发言、Bot 被动/主动以及本地/跨机提示边界也已实现并验收。见 [权限设计](group-governance.md)、[最终证据](group-governance-evidence.json)、[启动说明](../../../ds-bot/dev/communication/README.md)。

- 完整插件测试 1461 项：1459 通过、2 项原有跳过、0 失败；27 项通信专项测试及另 1 项本地提示回归。
- Hub 26 项全通过；真实双 DSH 新权限/隐私 7 场景通过；追加后 P4 的 7 恢复、8 网络、11 行为、2 原子性场景重新通过。
- 新 smoke-governance 全 52 步通过；构建一致性、lint、实际 tarball 干净安装与启动检查通过。
- Chrome 新权限矩阵、实际发言、移交/移交回、管理员边界及 508/700/1024px 生产 iframe 布局通过。原生 OS 窗口缩放未测。
- 11 个本任务 bench 的 22 个记录进程核验均停止，相关 22 个监听端口已释放；只关闭本任务临时页面，原用户页面保留。测试数据保留，未操作 VirtualInput。
- 分支 chore/federated-communication；基线 6ede702b7d698a8d86261ecb6a2a5f1efc8e1e87 不变，修改未提交、未推送，DSH 源 checkout 无修改。
- 没有待登录/待审批事项。不同 IP、WSS/NAT/公网、真实模型语义与其他 OS 未测；没有真实远端连接、持久凭据、服务或防火墙改动。

下面为历史快照，以本检查点和最终 evidence 为准。

最新检查点：P0–P4 本机隔离 Mock 门禁已通过，详见 [P4 验收](p4-acceptance.md)。后文保留较早调查快照，旧 PARTIAL/BLOCKED/未实现描述不代表当前状态。追加群主/管理员及提示词需求从此检查点继续。

## Goal and checkout

Implement communication between explicitly authorized Human and Bot identities,
without task management or sharing existing private chats and memory.

- Host: `<Windows test host>`, native Windows / PowerShell.
- Checkout: `D:\git\DS-Bot-federated` (new isolated clone).
- Origin: `https://github.com/KarlToon-FFAC/DS-Bot.git`.
- Source branch: `docs/federated-communication`.
- Source commit: `6ede702b7d698a8d86261ecb6a2a5f1efc8e1e87`.
- Implementation branch: `chore/federated-communication`.
- Plugin: `0.2.6`; DSH target: `0.2.1-rc.4`; Node: `24.13.0`.

## Stages

1. P0: establish repeatable isolated dual-DSH startup and probe the public API's
   input/output persistence, identity and Session boundaries before building UI.
2. P1: authenticated durable communication service and local queues.
3. P2: Human/Bot adapters and reconciliation.
4. P3: shared conversation UI.
5. P4: fault injection, recovery and regression acceptance.

Current gate: P0, P1 and P2 PASS on the isolated local bench; P3 PARTIAL.
The production adapter passed 11 real-host integration cases, including all four
DM directions, exact admission/export crash reconciliation, retained Session
rotation, private-chat isolation and offline target recovery. Plugin regression:
1450 tests, 1448 passed, 2 skipped; communication-specific plugin cases: 17.
Hub cases: 17. Original host smoke: fresh `smoke-p2`, 52/52 PASS, stopped.
See `p2-adapter-evidence.json`. P3 now has a production UI and five passing
real-group integration cases. Both Chrome pages were authenticated by normal
DSH startup and verified actual Human group/DM sends, exact local/remote authors,
draft isolation and refresh. Canonical messages were unique and model calls
remained A=37/B=39 for the Human-only sends.

The real minimum-width check did not pass: the documented viewport override did
not change the DOM dimensions, then native Chrome selection was stopped by a
Computer Use URL-confidence guard. No further Computer Use was attempted and no
account login or approval card is pending. P3's remaining browser matrix is
explicitly unverified; see `p3-ui-evidence.json`. P4 has not started.

Latest P3 regression: plugin 1452 tests / 1450 passed / 2 skipped / 0 failed;
19 communication-specific plugin cases, 21 Hub cases, lint PASS, generated client
rebuilt, fresh original host smoke `smoke-p3` 52/52 PASS and stopped. The group
demo was also stopped through its owned stop sentinel; data is retained.

Clean package verification: Hub tarball dependency install, loopback startup,
health and shutdown PASS. Plugin tarball contents exclude dev/test/profiles;
the actual tarball installs and imports its full plugin, production adapter and
SDK in a fresh consumer using the pinned complete DSH `0.2.1-rc.4`, without the
checkout's resolver or junctions. A first attempt to add packages into the
peer-declaring extracted package hit npm 11.6.2 Arborist's `undefined spec` error;
a minimal peer-only consumer then lacked DSH's required peer services. The final
clean consumer declares the complete pinned host and passes. No source package
versions were upgraded. These checks do not replace P3/P4 browser/fault acceptance.

Final process check: A/B Mock and Web records report `Running=False`; this task's
3101/3102/3191/3094/8794/8801/8802 ports have no listeners. Original VirtualInput
processes and files were not modified. Source and implementation branches still
point to `6ede702b7d698a8d86261ecb6a2a5f1efc8e1e87`; implementation remains
uncommitted, with no push, publication, installed service or firewall change.
Historical snapshots below retain their original state and are superseded by the
latest dated evidence; starting processes alone does not demonstrate acceptance.

## Environment preparation

The initial working tree was clean. The handoff, protocol, implementation,
environment, acceptance, vision, group and role documents have been read.
Repository skills cover issue triage and GIF capture; neither applies to this
API-first stage.

Dependency installation uses the official npm registry and a project-local
`.dsh-test-tools/` cache. The machine's npm defaults are offline and use a mirror;
command-local overrides leave those defaults unchanged. pnpm is project-local.
No real model key or existing DSH profile is used.

Baseline client/Office build and generated-file check pass without changing
generated files. The Windows sandbox initially rejected the esbuild child
process (`spawn EPERM`); the approved standard build then exited 0.

Other projects, including `D:\git\VirtualInput`, are outside this task and have
not been changed or stopped. No push, publication, persistent service or firewall
change is authorized or performed.

## Implemented slice: native bench and public Session journal

Added `ds-bot/dev/communication/bench.ps1`, the public-profile host launcher,
test-only probe bundle, and repeatable initial/recovery verifier. The bench
records process IDs, creation times and command paths; it starts hidden, binds
only loopback and stops only verified owned processes. The two instances have
independent DSH data, actual Chief identities, login cookies and workspaces.

Added `src/host/federation/session-journal.js` and six regression tests. It uses
public `sessionController.inspect`, retains exact source identity, distinguishes
pending/admitted/canceled/unknown input, and scans retained Session segments for
stable final-output identities. It excludes reasoning and unfinished/interrupted
or tool-calling output, and explicitly rejects unsupported media. No production
federation lifecycle or route is registered yet.

See [run instructions](../../../ds-bot/dev/communication/README.md) and
[sanitized evidence](p0-api-evidence.json).

## First-slice verification on 2026-11-03

| Check | Result |
|---|---|
| Initial dual real DSH + Mock probe | PASS |
| Exact source IDs and separate conversation Sessions | PASS |
| `followup` and `steer` public admission | PASS |
| Same logical input retried without another model call | PASS |
| Final text source identity retained across a new segment | PASS |
| Durable queued input without waking a model | PASS |
| Force-stop/restart both hosts with original data; cold reinspection | PASS; original identities, inputs, pending inbox and output source keys retained; no extra model calls |
| Full `npm test` | PASS: 1439 tests, 1437 passed, 2 skipped, 0 failed |
| `npm run build`; generated-file `--check` | PASS; no generated-file difference |
| `npm run lint` | PASS; pre-existing warnings remain |
| Existing real DSH host smoke | PASS: all 52 steps |
| Package file list and import from a clean extracted package | PASS; journal included, test probe excluded, no checkout dependencies for journal |
| Process cleanup | PASS; A/B and smoke DSH/Mock processes stopped, data retained |

The first full unit run failed three existing tests during Windows junction
cleanup. The same three failures were reproduced using `git archive` of the
unmodified source commit with identical dependencies (79 tests, 3 failed in the
two selected files). Fixture cleanup now unlinks its own known junctions before
removing their targets. No behavioral assertion was weakened; the final full
suite is green. Archived baseline and raw test logs remain in ignored test
directories rather than being published.

## Current boundary and next work

**P1 transport gate PASS.** The independent `communication-hub` service and
durable client queue/transport are implemented. Sixteen separate transport tests
pass, including independent-process commit/ACK-loss, forced Hub death, automatic
reconnect, simultaneous reverse DM creation, membership/rejoin boundaries,
revocation, bounded complete-message pages and atomic exports. These sixteen
cases are separate from the original DS-Bot suite: 1445 tests, 1443 passed,
two skipped. The fresh `smoke-p1` passes all 52 original regression steps.
Both lints, generated checks, clean installed Hub startup/health/shutdown and
clean packed client-module imports pass. The new CI job has not run remotely.
See [P1 evidence](p1-transport-evidence.json) and
[Hub instructions](../../../communication-hub/README.md).
P2 production receipt adapters and DSH integration are next. WSS runtime,
different-IP and real-model acceptance remain NOT_RUN. No model/real-account
login is needed for the ongoing isolated tests.

**Latest result: P0 capability gate PASS.** The earlier BLOCKED snapshots below
are retained as history and are superseded by this paragraph. Real Chrome
testing found and fixed two probe issues invisible to the earlier unit test:
the framework overlay layer was below DS-Bot's sidebar, and its late composer
focus restoration could steal focus after refresh. The test probe now uses
the public overlay slot plus the same standard React portal pattern already
used by DS-Bot, with a focus boundary on its own pane. It does not modify DSH
styles, kernel or private client state.

Actual browser navigation, group/DM drafts, Human sends, history/refresh,
selection restoration, return to the original Chief and hidden-composer Enter
isolation pass. The original Chief draft was preserved and then cleaned up;
Chief event count stayed at five and UI operations made zero model calls.
There is exactly one new group projection and one new DM projection. Fresh
dual-host initial/restart-recovery probes pass too. Full tests remain 1445 total,
1443 passed, two skipped; lint and both generated-file checks pass. The existing
React case now also reproduces focus stealing, without inflating the case count.
P1 may now begin; full communication acceptance is not claimed. A/B were stopped
after testing and their data is retained. User-owned Chrome is left untouched.

The complete log path and Markdown separator error are corrected in
[the login review](p0-login-review.md). Future page opening is authorized; the
user need not repeatedly locate a hidden directory or authenticate again.

### Earlier P0 investigation snapshots

The follow-up P0 work adds real process-loss checkpoints at public `pre-step`
and `turn-stopping`, exclusive idle-writer recovery through public APIs, and
recovery of a persisted final `stop` response whose `turn/end` was lost. Active
calls are denied replay grants. The two real-host crash probes now pass:
claimed-but-unadmitted input is retried once only after fenced reconciliation;
the existing persisted final response is recovered without another model call.

The actual persisted B Mock reply is also fed into A's test-only Human group/DM
projection. Author and recipient identity, duplicate handling and unread/read
state pass, with no new A Chief events or model calls. This is not Hub transport
or the final production Human adapter.

A test-only client adds a sidebar panel, a separate public `main` seat and a
`shell.overlay` status marker. Real React/JSDOM tests verify separate drafts,
focus and Enter propagation. React/ReactDOM `18.3.1` are pinned in the test harness
to match the fixed DSH frontend; DSH remains `0.2.1-rc.4`.

**P0 is still BLOCKED on real-browser acceptance**, so dependent P1–P4 have not
been started. The pending-followup recovery blocker is now resolved locally:

- `resumePendingInput` uses a truthful, separately sourced host-restart notice
  through public `agent.steer`. The original pending input is never removed or
  re-authored. The real crash probe proves the same DSH input ID is admitted,
  one Mock call produces final output, and retry plus a second restart add no
  calls. See [the updated recovery evidence](p0-recovery-gap.md). Production
  startup integration and transactional communication storage remain later work.
- Real-browser focus/navigation/refresh checks await the isolated local DSH A
  launch login. This is not a GitHub or real DeepSeek login, and Mock testing does
  not require a real API key. The secure local panel-open request returned queued
  while this delegated task was hidden; it has not been counted as executed.
  The parent thread is coordinating any user login action.

The official npm latest tag was read as rc.5. Its two Agent packages were only
downloaded for API/source comparison. Correction: public `send` exists in rc.4
as well as rc.5; it is not a newly added rc.5 declaration. It appends before
waking. rc.5 has not been installed or runtime-validated, and no upgrade is needed
for the verified lifecycle-notice path.

Compared with the earlier 1437 passing tests, the follow-up adds six communication
unit cases (three journal-recovery boundaries, one real React/JSDOM interaction
case and two pending-recovery notice cases). The communication unit suite now has
twelve cases; real-host crash and Human
checks are separate scripts, not part of the unit count. The latest full suite
has 1445 tests: 1443 passed, 2 skipped, 0 failed. Lint and generated-file checks
pass. A fresh isolated host smoke (`smoke-p0-3`) passed all 52 original steps;
those steps are regression coverage, not federation acceptance. Reviewable new
evidence is in [the P0 follow-up summary](p0-followup-evidence.json).

Hub authentication, canonical memberships/routing, transactional outbox/inbox/
export storage, production Human/Bot adapters and the complete communication UI
remain unimplemented. Full DM/GR/ST/AC acceptance, different-IP networking, WSS
and real-model behavior remain NOT_RUN.

Changes are local and uncommitted; nothing has been pushed or published.

All recorded A/B and `smoke-p0-3` processes have now been stopped, all six test
ports were released, and no direct descendants of the recorded test processes
remain. Test data is retained. The browser visibility override was restored;
the explicit temporary-tab close API reported `browser.user unavailable`, so
normal platform temporary-tab cleanup applies. When ready for UI validation,
restart A with the documented command and use that isolated instance's current
launch login; do not treat the earlier queued panel request as a completed login.

A direct attempt to select the task in the native ChatGPT window required
`Allow Codex to use ChatGPT?` app-control approval and timed out before any
navigation. It was not retried without new approval. This is a concrete desktop
control boundary, not a requirement for the user to supply real-account login.
The exact procedure and original P0/recovery requirements are recorded in
[the login review](p0-login-review.md). A fresh packed helper import also passed,
and test/profile files remain outside the published package file list.

Latest UI attempt after explicit user authorization: native app control now
works, the minimized window was restored, and the exact DS-Bot task was selected.
No new approval card or ID was produced. Secure browser launch still returns
`queued` despite the visible task; direct root remains unauthenticated. Actual
UI acceptance remains BLOCKED. A is temporarily running for the local startup
authentication handoff (web 16092, Mock 18044; 3101/8801), superseding the previous
all-stopped snapshot. B/smoke remain stopped. Stop only A via the runbook command
after the pending UI test/handoff; never stop processes by name.
