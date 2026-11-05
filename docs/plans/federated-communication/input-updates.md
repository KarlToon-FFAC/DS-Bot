# Reliable handoff updates and accepted reply completion

This extends the approved public-output design. A queued send is not delivery evidence. The Session final stays durable until the Hub accepts the explicit reply; permanent rejection lets the substantive final take the ordinary export path. An unknown outcome is retried under the same message ID. Only accepted publication consumes the final. Interrupted-turn recovery also waits while that tool publication is pending and skips generation after acceptance. This matters because a public result can arrive before the model finishes its private closing text; a host restart in that interval must not regenerate the answer. No text keywords decide suppression.

## Supplemental input

`update_communication_handoff` names the original handoff message and exact recipient. The Hub verifies that the caller authored that handoff, that it has an open AI delivery to that recipient, and that the recipient still belongs to the same membership epoch. A late update fails with `HANDOFF_ALREADY_COMPLETED`; it does not silently start another task. The update is public conversation data and visible in the original reply chain. It carries no new activation targets or AI delivery.

The recipient stores it durably and resolves the original delivery and Session. It uses the documented Session steer API, then reconciles the persisted user message on recovery. Admission alone is insufficient: `bot.input.read` is emitted only after a model step starts with that input. This proves input admission to a model step, not comprehension or successful use. Receipt publication is durable and idempotent. A supplementary input borrows the original task grant, never a new work grant. Existing work-start deduplication therefore keeps one logical work start.

Final export waits for all relevant supplements to reach a model step before that final. It includes the covered update IDs. The Hub also checks that all accepted updates are covered and their read receipts arrived; this closes the race where an old result was already queued when the update arrived. Read receipts are flushed before final outbox messages. Disconnects retain both. Authorship, membership, exact epoch and Session scope are checked independently of model instructions.

## Recovery and compatibility

The inbox stores injection state and the Session message mapping. Reconciliation precedes retry; uncertain injection fails closed until the exclusive Session history resolves it. Revocation blocks read receipts and final publication under the old epoch. Already published content is not withdrawn. Cross-segment ambiguous update mappings fail closed rather than claiming delivery.

Both ends require `bot-input-updates`; old peers fail capability negotiation before publication. Hub and local queue schema version 4 prevent older binaries from opening upgraded stores. Deploy the compatible Hub and clients together; retain a consistent pre-upgrade backup if rollback is necessary. No DSH package is patched.

## Output and limits

Internal reasoning and tool receipts remain in execution Sessions. Read-in and working information use structured status events. Explicit useful messages, failures and substantive final results remain available. The existing default-on, locally configurable memory policy is unchanged; update text cannot grant tools or permissions.

A pending immediate reply can delay its final during an outage; the UI must continue to show pending, not delivered. An explicit rejection can still mean the final itself is rejected by current membership policy; the result remains auditable, not guaranteed publicly deliverable. Old rejected attempts remain visible in diagnostic history even after a newer result succeeds. This is not a general task-management system.

## Evidence

`input-updates-evidence.json` records the real-model baseline and final fault run. Human-to-A-to-busy-B-to-A returned 42 after correction, with one B Session, one work start, one update input, one read receipt and no update AI delivery. A publication ACK was deliberately dropped; both hosts restarted without new model requests or duplicate public messages. A separate real-model tool publication received one permanent Hub rejection; exactly one substantive final was published afterward. Failed model-behavior and test-guard attempts remain in the local audit ledger. This does not prove every mid-injection crash window or the original live deployment root cause.
