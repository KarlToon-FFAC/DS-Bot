# Explicit outbound intent, audience boundaries and bounded Bot dialogue

2026-11-10. Proposed design for the two reported incidents. This document does
not change runtime publication or activation behavior. Keep release numbers
unchanged until the user requests a release.

## Findings from the current implementation

- `federation/runtime.js::export()` reads completed isolated Session outputs,
  creates `message.publish` from their final text, and commits them to outbox.
  An accepted immediate tool reply can suppress a final, but uncertainty retains
  the final and rejection can publish it as a fallback. The prompt explicitly
  says final text is shared. This is the federated incident's actual export path.
- Hub `store.js::publish()` sets DM recipient AI eligibility to true independently
  of structured Bot activation targets. Thus each published Bot final can start
  another Bot turn. Causal depth and per-root budgets eventually stop a chain;
  they do not prevent intermediate disclosures or needless model invocations.
- Local `turns.js::expectsReply()` covers request/stopped, not every trigger.
  `finish()` also completes delegated work for its original asker. Removing all
  `tellSender()` calls would break local work completion rather than fix the
  independent federated exporter.
- Local reply-triggered turns are not generally hidden by `claimTrigger()`.
  Their visible text can therefore be mirrored by a consumer that treats all
  assistant finals as user output. Existing bounded `exchangeTurns` hiding is
  a UI projection, not a durable external-delivery authorization mechanism.
- No WeLink gateway/mirror implementation is present in this repository. Its
  raw-event subscription must be reviewed separately; changing this plugin alone
  cannot force an external consumer to honor metadata it ignores.

## Output decisions

Separate completion of computation from authorization to publish content.
Every remote Session final is local journal content by default. It never becomes
an implicit network reply, a fallback after a failed send, or an automatic local
Chief report. There is no keyword, text separator or magic silence token.

Expose explicit, source-bound response decisions using supported tools:

| Decision | Network content | Task outcome / activation |
| --- | --- | --- |
| Reply | Only the text/attachments explicitly passed to the reply tool | Completes the authorized input once after Hub acceptance |
| No reply | None | Terminal control receipt, no chat text and no new AI activation |
| Ask a follow-up | Explicit question plus exact activation target/work context | Continues the same bounded task; no new root from a remote turn |
| Report locally | Explicit local report to an authorized initiating workflow | No remote publication; remote origin remains attached |

Both passive and active Bots can explicitly reply to their own current delivery.
This consumes the exact existing reply grant and does not give passive Bots
proactive or cross-conversation authority. Host code derives source delivery,
recipient, conversation, epoch and causality; the model cannot choose an author
or replace them. Active proactive sends remain distinct from authorized replies.

A completed turn without a send must not force a text reply. An explicit no-reply
decision gives the clearest terminal outcome; an absent decision remains local
and can show a local no-public-reply diagnostic. Failed model calls and denied
work use typed status, not automatic exception/chat-message publication.

Persist the decision, original operation/message ID, exact source and acceptance
state. A pending send is not completion. Retries reuse the same intent and
payload; rejection cannot promote arbitrary subsequent final text to outbound.
Already completed explicit sends cannot be followed by an automatic second final.

## Delivery is not activation

Distinguish message intents such as request, result, notice and acknowledgement.
A Bot DM is not an unconditional AI trigger merely because it is a DM.

- A request requires an explicit recipient activation and a valid task grant.
  Local user-initiated proactive work can create one task/root; remote-triggered
  tools must inherit their source task even if they omit visible reply text.
- A result can resume its exact outstanding requester/workflow once. It does
  not launch an unrelated chat turn. This preserves useful A→expert B→A results
  while preventing acknowledgements from turning into new assignments.
- Notices/acknowledgements and no-reply completion receipts are stored/displayed
  as appropriate but do not automatically wake an agent. Receiving an answer
  does not create a duty to thank or acknowledge the sender.
- A useful follow-up explicitly continues the existing task. The Hub enforces
  the original root, epoch, expiry, fan-out/delivery budget and round budget.
  Renaming a task, generating a new message ID or dropping source metadata cannot
  renew it. Human-authorized new work is a separate, auditable root.
- Retain existing deduplication and causal limits as emergency safeguards, with
  additional per-principal rate limits against many independent roots. They are
  not the main dialogue-completion mechanism.

Closing a task is an idempotent control-plane operation, not a goodbye message.
No-reply, answered, declined and failed statuses must be distinguishable from
stored, accepted and started. Receipts never generate more receipts as chat text.

## Local audience and mirror boundaries

Derive trusted metadata from host-owned inputs and work lineage, not prose:
trigger origin, initiating root/work, Session/turn, source delivery, audience,
exact recipients, output intent and protocol kind. Preserve the root audience
when a local sub-Bot result resumes genuine user work. Do not simply mark every
reply trigger user-visible or suppress every delegated user answer.

A protocol result to another local Bot and a user-facing answer are different
outputs. Bot-triggered internal work, remote work and internal reports do not
inherit user-mirror permission. A locally configured scheduled notification may
have its own explicit user destination. Mixed-input turns need explicit output
authorization rather than letting the latest input silently change audience.
Use a durable per-output routing ledger; a bounded UI hidden-turn list cannot
be the replay/history security boundary.

Provide a canonical user-visible-output feed with exact audience/binding checks.
WeLink must consume that feed or apply equivalent host metadata, rather than
forwarding every raw DSH assistant final. Raw DSH journals remain available to
the authorized local owner; they are not automatically public/mirror output.
Do not patch DSH or pretend a hidden UI row changes raw Session event access.

Remote Sessions must not gain unrestricted `message_bot` or local management
merely to report to a Chief. Local reporting requires the existing authorized
initiating work context or a separately scoped local bridge. Remote source claims
remain untrusted evidence; this is routing provenance, not the deferred D4
problem of proving a remote result's truth.

Explicit send controls prevent accidental routing. They do not semantically prove
that every model-selected sentence is safe to disclose. Keep private-only context
out of remote prompts, preserve the approved bounded memory/workspace settings,
and allow local-owner approval for disclosures that require it.

## Audit, upgrade and compatibility

Record metadata for every send/skip/block/defer: decision ID, root/work, trusted
origin, source delivery, Session/turn/output ID, audience and exact recipient,
transport, explicit tool intent, byte length/hash, acceptance state and reason
code. Do not duplicate private text, keys or provider responses into audit logs.
Expose local-operator diagnostics for why a turn did or did not send/wake.

On upgrade, quarantine uncommitted legacy automatic-final exports instead of
flushing them under the new policy. Keep proven Human/explicit-tool intents and
accepted history intact. Recovery must not manufacture a fresh outbound intent
from an old final or replay no-reply decisions as model work. Old deliveries and
already published messages are not magically retractable by this change.

The client can stop its own automatic final publication first. Intent-aware DM
activation and terminal receipts require an explicit negotiated capability when
wire semantics change. Report a precise compatibility/update requirement rather
than showing offline or silently treating an old client as compliant. Cosmetic
Hub/GUI release differences remain compatible. Do not bump release numbers as
part of this design note.

## Acceptance matrix and implementation order

1. Client stopgap: remove implicit final export/fallback, add explicit reply and
   no-reply decisions, update prompts and local audit/recovery. Verify private
   final canaries never enter outbox or Hub even after send rejection/restart.
2. Hub/client dialogue contract: request/result/notice semantics, exact waiter
   resumption, terminal control receipts, negotiated compatibility and budgets.
   Prove one question/answer terminates without an acknowledgement chain; an
   explicit useful follow-up still works in the original bounded task.
3. Local work/mirror contract: source/audience lineage and user-visible-output
   feed, then update the external WeLink adapter. Verify delegated user work
   still produces its intended user answer, while internal reply/report text
   cannot appear in that feed or an unrelated remote conversation.
4. Two real isolated DSH instances plus Mock: Human and Bot DM, passive/group
   replies, simultaneous tasks, no reply, explicit send plus private final,
   pending/rejected sends, crash windows, supplements, mixed inputs, old queued
   automatic finals, capability mismatch, and zero duplicate sends/activations.
   Use distinct internal-canary/public-answer strings and assert actual Hub
   records and outbound requests, not model prose claiming success.

For an ongoing storm, pausing the local Hub connection retains identity/history
while stopping that side's transport. This is a temporary operational action,
not a substitute for the output and activation changes above.
