# Optional local memory in remote conversations

The user approved a default-on local-memory option on 2026-11-05, after real-model collaboration validation. This revises the earlier no-local-memory design only for the bounded read-only section below.

Set `communication.localMemory: false` in the local plugin configuration to disable it; omission or `true` enables it. The setting is local-operator configuration, is preserved by Hub profile configuration updates, and cannot be changed by a remote group member or Bot tool. Normal plugin configuration reload applies the change.

Only the executing Bot's own main `MEMORY.md` entries are made available to its communication model. Source metadata, topic files, private-chat history and summaries, team memory, other Bots, groups and archives are excluded. A pending or failed memory transaction and unavailable storage produce no section. The existing secret classifiers exclude recognized secret entries; this is best-effort filtering, not a guarantee that arbitrary prose contains no sensitive information. The user should disable the option when this audience must not receive personal-memory-derived answers.

The section is reference data, not permission or instructions. It grants no filesystem, memory-write, execution or additional conversation tools. Exact conversation/membership checks remain unchanged. Data already included in earlier model requests or replies is not recalled by turning the option off; existing replies remain in history. Memory does not get replicated as a Hub database or an automatic chat message.

Default-on scope is deliberately the Bot's main memory, not every local memory scope. Broader scope and a per-conversation UI can be added separately if requested.

## Duplicate-work investigation

Two visible B work items must be correlated by deployment revision, source message ID, delivery ID, membership epoch, Session ID, turn and actual started-step sequence. Different messages can legitimately create different deliveries. One delivery repeated across transport/recovery must retain one logical input and canonical start receipt; an interrupted model attempt can resume without being a new assignment. Two A texts containing an at-mention are not sufficient evidence of two activations: inspect structured targets and causal grants.

The real-model baseline proved one A-to-B assignment and answer, original-message retry plus B restart without regeneration, and display-only Bot mentions without B activation. These do not prove the reported live two-message incident is fixed. The additional double-message study retains each message and target in private synthetic evidence. No live Hub or user chat was inspected or changed.

## Validation on 88 (2026-11-05)

Real `gpt-6-luna`, fresh synthetic DSH A/B and Hub: a continued tool message and final message both contained an at-mention and structured target B; the first produced one B AI delivery, the second zero. B had one admitted input, one canonical start and one Session. This validates the current source, not the unknown live deployment revision. An earlier trial failed because the model supplied a DM-only contactPrincipalId in a group send; the host correctly rejected it. The group prompt now explicitly explains that parameter boundary.

Real-model memory checks passed: default-on answered from a synthetic main-memory entry; disabled excluded the canary from the outbound request and answered UNKNOWN. A stop/restart after persisted final but before export produced one original input, one export and zero new model requests. No real user memory or group was used.

The controlled Hub causal suite passed 13 tests, and native local-team Mock smoke passed 52 steps. Generated-client freshness and lint passed. The full plugin suite retains two unchanged GUI failures: communication-usability's reply-chain composer assertion and style-debt's 7px radius. These belong to the parallel GUI integration. The old prompt-string assertion was aligned with the existing structured-handoff policy.

Private synthetic evidence is retained outside publication in `.dsh-test-tools/ab-collab-20261105-real/`: attempt-7 records the two-message case; result records memory and crash recovery; earlier attempts and budget expansions remain intact. Real trials are empirical examples, not a guarantee for every model response or an actual live-incident diagnosis.
