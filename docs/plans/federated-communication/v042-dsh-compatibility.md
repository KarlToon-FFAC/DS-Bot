# DSH 0.2.2 compatibility (V0.4.2 batch)

Target: npm default channel **0.2.2-rc.1**, with **0.2.1-rc.4** retained for this migration window. rc.3 is not the supported release target. Plugin, Hub and desktop metadata remain at the existing V0.4.1 release; the desktop's stale V0.2.6 metadata is aligned with its plugin as required by its existing packaging contract. No Hub protocol change is required.

## Public SDK boundary

0.2.1 uses individual tool execution and assembly schemas. 0.2.2 uses batches, step admission, and separate native/PTC executors; its assembly waterfall no longer owns the final schemas. Merely making `assembly.tools` optional would expose tools the Bot intentionally hides.

`host/tool-compat.js` detects the public batch/resolve/setExecutor API. It prepares known local Bot and authorized remote Session scopes before model admission. It inspects public prompt declarations to retain built-in native versus PTC presentation, then installs a scoped built-in executor with the Bot's existing tool filter. Both descriptions (including PTC SDK sections) and execution admission are filtered. Original step selections are never widened: conditional registrations require admission, new registrations wait for a new step, disposed selections remain closed, and foreign agents cannot read the subset. No DSH implementation is patched or imported through private install paths.

Legacy DSH keeps its existing executor and schema filtering. Remote host-generated `tool-registry` snapshots are dropped like other host-only context; they do not become task authority. Skill aliases, local management boundaries, explicit remote submission and source validation remain intact.

## Limits

- Built-in profile-level native/PTC providers are supported. Arbitrary third-party executors cannot be transparently preserved: this SDK has no public API to retrieve and wrap the selected executor. A provider registered directly in the same Bot Session scope causes `BOT_TOOL_EXECUTOR_CONFLICT`; select the built-in provider in the parent profile. No provider is silently removed or overwritten.
- Tool registrations added after a 0.2.2 step was admitted become available on the next admitted step. The adapter does not rebuild private model-loop state. Initial team/work registrations are synchronized before input admission.
- DSH 0.2.2 requires Node >=24.9.0. The older Node 22 CI lane uses only 0.2.1. Compatibility is verified at these exact prereleases; future releases require validation.
- Back up the profile and use an isolated copy for host upgrade testing. Support for two APIs is not a guarantee that older DSH can read newly written profile/session formats. Restore the backup to roll back the host.

## Packaging and validation

The desktop and development harness pin 0.2.2-rc.1, including the new executors and packaging peers. Dependencies resolve without `--force` or `--legacy-peer-deps`. CI exercises old and new SDKs on Windows and Linux. `DSH_HARNESS` selects an isolated install for tests and communication benches.

Validation uses mock models only: full plugin suites for both SDKs; native/PTC presentation and admission tests; 52-step local smoke for each host; new-host dual-instance @ and optional-tool conflict/recovery, file/Shell work and Bot DM delegation; desktop unit tests/build; generated client check and lint. Windows execution is delegated to the committed CI matrix, not claimed as a local Linux result.

Local Linux results (2026-11-17): each SDK ran 2,281 plugin tests, with 0 failures (0.2.1: 2,273 passed / 8 skipped; 0.2.2: 2,276 passed / 5 skipped). Both hosts passed all 52 local smoke steps. The 0.2.2 dual-instance native conflict, binding recovery/restart and eight native-work checks passed, including local-owner approve/reject and read-only denial. Desktop: 231 passed / 1 skipped, build passed. Both SDK linters and the generated client check passed. Desktop/mobile browser avatar and contrast checks passed across four themes, light and dark. Concurrent initialization is covered explicitly: a second input waits for executor readiness rather than bypassing the filter while prompt inspection is in progress.
