# Complete federation reset integration

This batch removes retained owner recovery, adds permanent device deletion, implements explicit offline full federation erasure, and makes navigation/status refresh automatic. The complete test record is in [the integration evidence](complete-reset-integration-evidence.json).

## Verification

The recorded source commit and tree passed all 18 serial local gates with deterministic Mock models. The real DSH acceptance starts with both legacy static pairing and signed SDK enrollment, creates actual remote history/attachments/projection data, resets the same profiles and Hub, rejects old credentials and codes, then enrolls fresh identities and gets a new Mock reply. A subsequent dry run requires every federation residue counter to be zero. Ordinary Bot state, local chat journals, model settings and unrelated credentials remain unchanged.

The remaining gates cover prompt-RPC fault recovery and its safety counterexamples, Host crash windows, the full plugin and Hub suites, behavior and network matrices, ordinary native smoke, relationship memory, IP remarks and IM lifecycle. The first full plugin attempt had one synthetic OpenSSL key-generation timeout before WSS setup (1954 pass, 1 fail, 4 skips). Its original log is preserved by hash. The isolated WSS suite passed 3/3, then the entire unchanged plugin suite was rerun at concurrency 1. The evidence records both attempts. Other existing failure evidence remains historical and is not relabeled as passing.

## Use on an actual deployment

Follow [the complete reset guide](test-hub-reset.zh.md). Stop every relevant Host, provide every actual profile/overlay and storage root, inspect a dry run, and confirm the exact same plan. Unknown ownership, inconsistent providers/roots, changed retry witnesses or unsupported residue block erasure. No backup or identity recovery is created.

The offline client command cannot erase another browser's storage or its parent's environment. It reports those pending actions explicitly. Complete each browser-origin/tab and launch-source check, reset the actual Hub, and inspect the final zero-residue dry run before calling that deployment fully reset. These local tests did not touch a real Hub, user data, a real model or GitHub Actions, and do not claim arbitrary kill-point coverage or physical cross-machine acceptance.
