# V0.4.1: isolate optional work-tool registration conflicts

A reported `COMMUNICATION_SESSION_UNAVAILABLE / work-context / Error /
work-tools.js:82:37` locates a failure in `agent.ctx.tools.register`, before model
admission. The reporter explicitly uses normal mode. That source location alone
cannot identify the conflicting tool or establish PTC as the cause.

## Reproduction

Two isolated native DSH 0.2.1-rc.4 instances and a loopback Hub reproduce the same
failure with the unchanged `fb6c407b` plugin. Both the local Bot and remote
execution scope use `native` presentation. Seed one new remote binding with a
real communication-preset Session, and let a test plugin own a scoped `read`
variant before work capabilities are imported. A human @ activates and stores the
message, but `read` registration conflicts at exactly `work-tools.js:82:37`;
AI input remains pending without a model turn. This is a native-mode reproduction
of the reported failure shape, not proof that `read` is the incident's tool.

## Behavior

Only a known same-scope registration conflict in an optional work tool is isolated:

- Keep the other registration intact. Do not claim ownership, remove or execute it.
- Omit the conflicting capability from active work tools. Existing communication
  assembly and execution guards hide/deny it; native and nested calls cannot fall
  through to the foreign definition.
- Continue preparation of other tools and admit the original communication input.
  Explicit reply/decline, membership, input provenance, directory and permissions
  retain their existing checks. No fabricated input or automatic prose forwarding.
- Expose `workToolWarnings` on local activity and diagnose, with binding/session,
  validated tool name and failure category. The Bot's own prompt also lists its
  unavailable tools and forbids claiming execution or bypassing them to repair
  local configuration on remote authority.
- Reconcile again normally. When the owner releases the conflicting registration,
  the same binding can acquire the capability and its warning clears. No queued
  input, identity, Bot publication or Hub data is reset.

Unknown registration errors still block preparation rather than disappearing.
Fatal registration diagnostics now identify `work-tools-register`, `toolName` and
`registrationFailure` (`scope-conflict`, `reserved-transport`,
`registration-failed`). Exception messages, raw stacks, credentials and task
bodies are not exposed. A transport-only connection error remains independent.

A separate PTC-owner case was reproduced with the real public DSH services:
`schemas(local)` includes reserved `run_code`; importing it as an ordinary tool
throws at that same original line. Exclude that transport from inherited work
capabilities; DSH supplies each scope's transport. This secondary fix does not
assume the normal-mode reporter enabled PTC.

## Verification

Use public SDK services, deterministic Mock and isolated test profiles. No DSH
implementation or production profile is modified.

```
node ds-bot/dev/communication/work-tool-conflict-acceptance.mjs --baseline-plugin /path/to/fb6c407b/ds-bot
node ds-bot/dev/communication/work-tool-conflict-acceptance.mjs
node ds-bot/dev/communication/native-work-acceptance.mjs
```

The SDK regression also attempts execution through the real tool pipeline and
checks that the foreign capability never runs. After owner release, twenty
concurrent reconciliations are idempotent. Non-conflict failures remain fatal.
The native positive fixture requires exactly one reply to the original input,
accepted AI admission, an explicit scoped warning, zero foreign tool executions,
and recovery on the same binding after the other registration is released.

Version remains V0.4.1. Deploy a newly built plugin artifact and restart its Host;
there is no Hub source/protocol change or required DSH upgrade. The exact incident
tool still needs the original exception or the new diagnostic if the issue
persists. These Linux tests do not certify a Windows installation or a real model.

`COMMUNICATION_PRESET_CONFLICT` is a separate startup check in communication.js,
before CommunicationRuntime construction and work-tool synchronization. Finding
that description in source is not proof that it occurred; an actual startup
failure with that code is evidence for investigating duplicate composition or an
unreleased preset. It is not a reason to delete conversation bindings.

Verified 2026-11-16:

- Full plugin suite: 2,277 cases; 2,272 passed, 5 skipped, zero failures.
- Native-mode negative control against fb6c407b: the original activated message
  stays pending with precisely `work-context / work-tools.js:82:37`.
- Native-mode patched control: original input is admitted and replied once;
  scoped tool warning remains visible, foreign execution count is zero; owner
  release restores the same binding and clears the warning.
- Real SDK tests cover native conflict isolation, hidden/denied foreign capability,
  idempotent concurrent recovery, reserved PTC transport and fatal unknown errors.
- Activity UI regression shows the warning and tool name only in its conversation.
- Native local-team smoke passed all 52 steps.
- Native file/Shell/DM/restart/directory-rotation/deny/allow-once tests passed.
- Generated-client consistency and lint passed (existing warnings remain).
