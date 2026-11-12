# Model readiness, Bot reply activation and local Chief reports

Released with plugin and Hub V0.3.7 after owner approval.

## Model readiness

The owning client checks the selected/fallback model route and missing credentials
without making a model request. It reports only bounded reasons: no model selected,
no available route, or missing model credential. Optional `bot-model-status` extends
the existing socket-bound presence lease. It does not disclose models, providers,
keys or raw errors. Stale/disconnected status remains unknown, never a stale warning.

The GUI shows a gray badge and explicit text in mention choices, selected/dispatched
recipients, member/contact views and delivery status. A model-blocked delivery is
still pending: no fake started/completed/no_reply receipt is emitted. The normal
persistent queue retries after local configuration is repaired, using the same
message and delivery. Old Hubs remain connectable; local diagnostics still work.

## Bot replies

User decision: Bot replies should implicitly notify their quoted Bot author, just
like Human replies. New clients negotiate optional `bot-reply-activation` and mark
group messages `replyActivation: implicit`. Hub routing unions the quoted author
with explicit targets, skips self, and preserves membership, publication, speaking,
deduplication and causal budget checks. The canonical event records actual recipients.
No prose scanning or automatic final-text forwarding is introduced. Bots may still
choose `decline_communication_reply` to stop without sending an acknowledgement.

The progress collector marks requests `replyActivation: collect`. Bound reports
are gathered by its existing wait/read path rather than waking the coordinator
once per report. An explicit urgent target still wakes it. Older clients/messages
without the negotiated marker retain their previous behavior.

## Local Chief bridge

Remote Sessions intentionally exclude the broad local `list_bots`/`message_bot`
tools. Their remote roster is not the complete local team. New narrowly scoped
tools `list_local_chiefs` and `report_to_local_chief` expose accessible local Main
Bots and submit an internal report without requiring Hub publication.

Reports require the host-authenticated current remote input and owned Bot binding,
not a supplied sender/destination Session. There is one consolidated report per
input and Chief; durable local request receipts deduplicate retries and mark an
uncertain outcome without resending. A private/non-Chief/self target is refused.
The source retains canonical conversation/message/author IDs, marks remote origin,
and explicitly grants no local-user authority. The Chief's turn and exchange are
internal, including retries and mixed input. Its final is not routed back to the
worker or Hub. This does not open general local team controls to remote Sessions.

## Validation

- Plugin suite: 2161 tests, 2156 passed, 5 skipped, no failures.
- Hub suite: 222 tests passed, including implicit reply/explicit-target union,
  collection exceptions, presence ownership and model-status recovery.
- Local report integration covers unpublished Chief discovery, durable deduplication,
  forged-source rejection, internal visibility, no automatic return, and restart.
- Browser checks cover missing model/credential notices, gray shared badges and
  live recovery without reload. Client freshness and lint pass.
- Native DSH mock smoke: all 52 steps passed on a fresh isolated bench. The first
  run hit a fetch failure while creating Writer and a dependent assertion failure;
  the clean rerun passed both steps and the remaining workflow.
- All tests use mock services; this does not probe a live model provider or validate
  credentials against one. Update both Hub and plugin for the new optional capabilities.
