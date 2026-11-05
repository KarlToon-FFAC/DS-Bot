# Public output boundaries and local memory controls

Approved scope: preserve default-on optional local memory, prevent execution chatter in local and remote groups, and verify real Human → A → B → A collaboration before integration.

## Message classes

Intermediate assistant text, reasoning and raw tool results belong to the execution Session. Local group turns now advance their final-reply boundary without publishing intermediate text or interpreting its mentions. Subagent-waiting parent text is not automatically a public progress post. Host working/failure events retain their existing structured paths.

A useful finding, blocker or handoff can be published explicitly. `post_to_group` now supports the currently executing local group through its existing group publication path; `message_bot` retains its scoped handoff behavior. Explicit publication survives an in-process steer continuation. Final results remain visible, including ordinary words such as “pending”; no new keyword filter is applied. Existing PASS behavior is unchanged.

Remote Sessions already export only the final assistant text from a completed, exclusively authenticated communication turn. Tool-call messages and reasoning blocks are not exported. Preferred handoff is staged structured targets followed by one final. An immediate active send normally consumes the reply grant; `continueReply` is an explicit exception for a distinct public update and final. Structured target deduplication is unchanged. The host cannot reliably classify a model's plain final text as private reasoning; prompts tell it to publish the result, not receipts.

## Local memory controls

Personal settings expose a default-on checkbox for the selected Hub. Only the authenticated local Human API may save it through the supported configuration editor. Remote tools cannot change it. Saving preserves other settings and triggers normal configuration reload; it is not an instantaneous cancellation of an in-flight model call.

Each Bot receives only its own main entries through its trusted local binding. Topic files, other scopes, source metadata and private chat summaries are excluded. Entries with trailing metadata `sharing: local`, `sharing: private` or `sharing: never` are excluded before the model request. Existing secret-pattern detection and the configured secret redactor exclude entire matching entries. These are explicit tags and heuristics, not general privacy classification. Existing entries remain eligible by default unless excluded.

The selected entries are sent to the configured model service as reference data in the communication system section. JSON encoding and instructions do not create a security boundary. The communication tool allowlist and authenticated membership checks are enforced independently. Injection tests verify that text cannot register or execute local file tools. They do not prove the model cannot repeat visible data.

The UI explains that replies are visible to all authorized conversation participants. `activationTargets` only selects Bot wakeups, not the audience. The implementation does not export raw prompts or memory blocks automatically; a model can still restate visible facts in its final text.

## Turning memory off and revoking membership

Turning memory off stops new memory reads after reload. It does not erase existing model context, session records, already shared messages, or a completed result awaiting export. An earlier public fact remains ordinary authorized group history. A fresh conversation with memory off receives no fresh local-memory section. This is an opt-out from new reads, not retroactive forgetting or an output-revocation switch.

Membership revocation is different: the Hub must reject old-epoch publication. The isolated real-model test holds a completed result before export, removes its Bot, restarts it, verifies no old result and no regeneration, then rejoins under a new epoch and verifies independent new work. No real Hub or private memory is used.

## Compatibility and limits

No DSH patch, database schema or protocol change is introduced. Configuration absence still means memory enabled. Existing histories are retained. GUI integration must retain the settings component import, panel placement, translations and rebuilt client artifact.

Same-input duplicate handoff suppression is not a reliable update channel: a second message can be stored without being consumed by an already busy Bot. Explicit update/read-in receipts and durable mid-turn supplementation remain a separate protocol change. This patch must not be presented as completing that broader design or proving the original live double-wakeup incident resolved. All real-model evidence is from two isolated instances on one Windows computer, not a cross-machine deployment.

## Verification

See `public-output-evidence.json` for sanitized real-model observations and validation results. Raw synthetic experiments and the unchanged cumulative budget ledger are retained locally under `.dsh-test-tools/ab-collab-20261105-real/`; credentials and Session dumps are not part of this change.

Final verification: 1683 unit tests passed, two skipped and two pre-existing GUI failures (reply composer at communication-usability:298 and 7px radius at style-debt:32). Local group/request-id 81 passed; final memory/security 83 passed; smoke all 52 passed; lint and generated-client checks passed. The GUI task must resolve its baseline failures during integration.
