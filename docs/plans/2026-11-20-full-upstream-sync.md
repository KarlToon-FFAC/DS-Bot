# Complete upstream synchronization for the federation branch

Date: 2026-11-20. Package version remains **0.4.3**.

## Baseline and scope

Merge `Fei2411/DS-Bot` **dev 6e2afaa92f2ea7cc9415979cedc4f0bf100f7268** (including tool-background, group approval islands and IM inbound media) into `chore/federated-communication`, based on federation commit `ac8de52b`. This is a full history merge, including the native plugin, desktop application, phone/link components, layout, documentation and tests. No upstream directory is selectively omitted.

The runtime and desktop dependency baseline is **DSH 0.2.2-rc.1**. DSH 0.2.1 and earlier are no longer supported targets for this synchronization. The old CI compatibility job is removed; remaining harmless compatibility adapters do not constitute an older-runtime support promise. Runtime packages use documented DSH APIs and are never patched.

The initial integration at `a676f7a7` was followed by the latest four upstream commits through `6e2afaa9`, fetched again before final verification.

## Native upstream features retained

- Shared group to-dos (`group_todo`), member task boards (`group_task`), staged group Goals (`group_goal`), their permissions, persistence and UI controls.
- New sidebar sections and layout, settings shell, text/quote interaction, activity and progress presentation, group overview and task/Goal panels.
- Background work and commands, multiple conversation parts, local agent integrations, change/claim presentation and updated skill workflows.
- Configurable Bot/group/team memory capacities, text-only size accounting, entry metadata, retrieval, review and archival of older entries. Canonical tools are `bot_remember`, `bot_forget`, `bot_recall`; generic memory names are not reintroduced into the tool registry.
- Native IM integrations (including QQ/DingTalk/WeChat inbound images and files), group tool/computer-use approvals in the top island, phone access, encrypted link/relay components and desktop changes from the selected upstream revision. The new phone/IM transports are separate from the federation Hub.

These upstream group features operate on native DS Bot group state. This merge does not invent a new Hub protocol or silently replicate native to-dos/Goals into Hub groups.

## Federation integration decisions

Preserve all existing federation features and authenticated source checks, including host model-selection notices, owned-session recovery, implicit DM reply activation, private closing text, explicit public replies, no-reply completion, bounded causality, local consultations and same-Bot memory/skills/history access.

Internal reply turns cannot inherit user visibility. User authorization follows host-observed output ranges and saved publication receipts. The new native intermediate group progress is retained for native group chats; remote final text still requires an explicit public send.

Scoped tools keep upstream dynamic registration and filtering while retaining ownership checks, withdrawal cleanup, stale-definition rejection and bounded public-API reassembly. A failed cleanup blocks the withdrawn tool. A foreign registration is never stolen. Native and PTC schema filtering remain under DSH's public assembly API.

A resumed user turn carries its verified user origin through a conversation-part switch, including failed-switch recovery. An internal or remote turn receives no such grant. Local/remote approval cards retain their appropriate local Human owner.

Desktop shared components use the app's existing primitive adapter rather than bundling a second DSH frontend. Existing translated native strings are preserved; federation strings without translations in the additional upstream locales use an explicit English fallback catalog. Chinese federation translations remain intact.

## Validation

Use only isolated mock profiles and scratch databases. Required checks include plugin unit tests and lint, generated bundle reproducibility, desktop build/tests, Hub tests, link typecheck/tests, browser isolation/write-safety tests, native smoke, two-instance federation source/DM/explicit-reply/shared-context acceptance, and real-browser group feature/layout/restart acceptance.

`ds-bot/dev/upstream-sync-acceptance.mjs` runs a real DSH 0.2.2 mock turn using the three group tools, verifies the user's to-do checkbox, checks the new details panel in Chromium when configured, and restarts the owned host to verify persistence. All test state is under `.dsh-test-*` and excluded from git. Production profiles and credentials are never accessed.

### Verified results

- Plugin: 3,966 tests, 3,958 passed, 8 platform-specific skips, zero failures.
- Desktop: 492 tests, 488 passed, 4 platform-specific skips; production build passed.
- Hub: 226 tests passed. Link: typecheck and 36 tests passed. Mobile: typecheck and 66 tests passed.
- Browser isolation/write safety: 22 tests passed with system Chromium.
- Native mock-host smoke: all 52 steps passed. Real two-instance federation acceptance passed for model-selection notices, DM implicit replies, shared own context/unpublished local collaboration, explicit/no-reply behavior, quoted recipients, bounded activations and missed-submission recovery.
- Latest group acceptance passed for real DSH tool execution, to-do checkbox updates, wide/narrow group details and persistence after restarting the owned host.
- Lint and generated bundle reproducibility passed. Native Windows/macOS-specific skips are not represented as execution on those platforms; mobile checks cover TypeScript and logic, not an Android/iOS device build.
