# Field report follow-up: trust recovery, CLI diagnostics and version status

The user supplied the condensed 2026-11-09 external report. Its detail report and
F1–F5 package are outside this workspace. Production Hub, devices and credentials
are not accessed. The user subsequently provided the Win11/DSH 0.2.1-rc.4 F2
reproduction and exact preset/escalation behavior. D4's original task, report and
rejection remain deferred at the user's request. This patch does not modify DSH
or claim that message provenance establishes the truth of a model's conclusion.

## Confirmed changes

F2: a native `ask` policy only dispatches explicit approval requests. It does not
turn an ordinary denied command into an escalation request. The remote prompt now
explains the distinction and tells the Bot to use only advertised native escalation
arguments, with a precise justification for a legitimate task. No automatic retry
or tool/preset switch is introduced after sandbox denial.

A separate, opt-in local-owner setting `remoteWorkApproval: ask` requests approval
before each remote `write`, `edit`, `str_replace_editor`, `bash` and `pwsh` call,
including ordinary in-workspace operations under danger-full-access. The default
`inherit` keeps the Bot's existing policy. Personal settings exposes the checkbox;
Human-only work-approval-settings/set-work-approval CLI/API endpoints persist it
through the public ConfigEditor and reload. The public setApprovalPolicy API sets
ask only on the remote Session, preserving the Bot's sandbox and its local Session.

The host records the source, exact path/command and working directory before the
public approval request. It clones arguments before waiting, grants one exact call,
and rechecks authorization, tool availability, cancellation and work context before
native execution. Missing service, rejection and cancellation fail closed with
separate WORK_APPROVAL_* codes. The existing local-only answer-work-approval card
handles the decision. Remote peers cannot set this policy or answer its requests.
Approval does not widen the sandbox; an outside-workspace action may require a
second, native escalation approval. Windows automatic deny-to-escalation behavior
remains an upstream DSH change, not a claimed fix in this repository.

F3: the transport intentionally stops retrying non-transient TLS validation errors.
Updating stored CA trust previously only closed a socket; it could not restart a
blocked transport. After the new trusted v2 code is explicitly confirmed and its
same-Hub TLS/challenge check succeeds, update-hub-trust restarts the selected
transport using the saved scoped CA. It preserves the queue, device key, instance,
principal identities and stale-connection fencing. It never enables ambient trust
or disables verification. Responses include reconnectRequested/restartRequired;
when no matching live runtime can reconnect, the response explicitly says whether
a Host restart is required. Persistence/validation failure never restarts a link.

F4: Bot-scoped local API/tool calls detect pending configuration reload before
using an old runtime principal or epoch, and return COMMUNICATION_RELOAD_REQUIRED
with reloadRequired:true. Publication generations participate in this comparison,
including a hide/show whose final selection is unchanged. No stale epoch is
silently replaced. CLI help specifies localBotId as the exact native Bot id from
available-bots, rather than a global principal, name or another Session id. The
publish-bots CLI also accepts expectedPublishedBotIds for concurrent-edit checks.

F5: a real CLI reading a remote custom avatar passes on two isolated DSH instances.
The reported universal failure on valid images is not reproduced. Stale revisions,
missing custom images and malformed chunk/image responses previously lost their
specific codes in the public diagnostic allowlist. Preserve explicit avatar errors
and explain that generated avatars have no downloadable custom image. Never expose
raw exception text/image bytes in diagnostics. Authorization and exact revision
validation remain unchanged.

## Connection UI

Hub welcome advertises an optional federation implementation release. Both
components use 2026.11.09.2, with a parity test. This identifies a federation release,
not the DSH/package version or a cryptographic source-code attestation. Update both
constants when publishing the next federation release. Old Hubs without this
metadata show "Version not reported"; do not invent their version.

Capability/protocol/schema incompatibilities produce a dedicated incompatible
status, their allowlisted exact reason and an update action in the connection
panel. A known release difference remains visible even when capabilities permit
connection. An ordinary network outage stays separate. Version labels do not
grant authority or replace capability validation, and matching release metadata
does not bypass any existing compatibility gate. Updates clear stale notices live.

## Reproduction entry points

- Plugin and Hub unit suites, generated-client check and lint.
- Real WSS CA-A rejection → trusted CA-B update → ready in one Host process:
  communication-hub-trust.test.js. Keys and principal identity remain unchanged;
  the original CA still fails, demonstrating that TLS verification was preserved.
- Two real DSH instances, Hub, Mock and actual dsbot-remote CLI:
  `node --import ./ds-bot/test/harness-resolve.mjs ds-bot/dev/communication/report-defects-acceptance.mjs`.
  Covers a valid remote avatar, stale revision, generated-avatar refusal, matching
  live version metadata and an actual remote Bot reply.
- Chromium desktop/mobile with production components and synthetic state:
  `node ds-bot/dev/communication/version-ui-acceptance.mjs`.
  Optional DSBOT_PLAYWRIGHT_MODULE / DSBOT_CHROMIUM_PATH select installed tools.
  Covers incompatibility, exact error/upgrade action, compatible differences and
  live recovery. This browser test does not claim to inspect production.

- Explicit remote confirmation against two real DSH instances and Mock:
  `node --import ./ds-bot/test/harness-resolve.mjs ds-bot/dev/communication/remote-confirmation-acceptance.mjs`.
  Danger-full-access local Bot; reject before the first write, then individually
  allow file creation, edit and Shell calls. No file exists before approval; the
  local Bot's permission remains danger-full-access. Uses the public approval
  service and existing Human answer route, with no DSH patch.

## Completed verification

2026-11-09: plugin 2,042 cases, 2,037 passed, five existing skips, zero failures;
Hub all 195 passed; generated bundle freshness and lint passed. Native DSH Mock
smoke all 52 steps passed and the owned bench stopped. Two-DSH CLI checks passed
six cases including both Human and Bot custom avatars; the separate native
confirmation run passed reject and allow flows under danger-full-access. Owned
integration processes were stopped by their fixture cleanup.

The CA-rotation integration uses a real WSS transport and a protocol/credential
fixture in one process, not an external Windows DSH deployment. Windows automatic
sandbox denial-to-escalation is not fixed here. D4 remains deferred. The valid-image
CLI failure is not reproduced; diagnostic corrections and positive/negative CLI
coverage are the confirmed F5 changes.

Safe counts and coverage: [evidence](field-report-20261109-evidence.json).
UI evidence: [desktop version status](screenshots/field-report-version-desktop.png),
[mobile version status](screenshots/field-report-version-mobile.png),
[local confirmation setting](screenshots/field-report-confirmation-mobile.png).
