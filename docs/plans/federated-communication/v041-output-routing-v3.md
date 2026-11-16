# V0.4.1 output routing v3

Supersedes the private-draft GUI surface in v041-output-routing.md. No Hub source
changes. Keep output routing schema independent from the team's root version.

Three independent records: append-only visibility facts (channel, time, actor,
confirmation level), delivery attempts/receipts, and a private pending owner with
its authorization. Legacy submitted-user is a classification observation, not
proof of a gateway frame. Never erase an exposure fact when a Bot delivery lands.

Every newly observed local turn starts with an internal/unclassified audience.
Host user input grants its normal user route. A schedule source gets its own
internal ledger and requires explicit publication. role=reply OR protocol=reply
never inherits user publication. Explicit directed user requests stay supported.
Live stream, canonical feed, history and native cells share these boundaries;
unknown live routing never defaults to user. Previously rendered text cannot be
retracted; keep its visibility audit and stop subsequent unauthorized output.

Only existing request/work credentials permit automatic return. Reply-to-reply
without work remains private pending; no textual short-ack heuristic. Automatic
returns have a persisted causal-chain budget. Exhaustion creates private pending,
not an automatic failure message to the other Bot. Explicit sends keep their own
request receipts and semantics.

No private pending body, preview, output ID or publish button in user chat/roster.
The owning Bot sees at most five reminders on its next activated turn. No notice
starts a turn. Chief access requires an explicit exact-output delegation; private
Bot disclosure crosses existing approval checks. Ownership, authorization and
privacy are rechecked before submission. Existing output IDs remain usable by
owners; legacy output status is retained only as a compatibility summary.

## Persistence and interfaces

`state.outputRoutingVersion=2` and each output's `routingSchemaVersion=2` are
independent of root team schema 1. Original text stays under its immutable
`outputs-<session hash>` ledger identity, excluding reasoning. Visibility facts
and delivery attempts/results are also appended to that ledger so bounded settled
state metadata does not erase the audit. Visibility facts have stable IDs; repeated
observation cannot overwrite an earlier exposure. The host saves a publication
intent before emitting a new ordinary output, then rechecks current routing.
An intent alone is not confirmed exposure. Local publication means availability in
local chat; stream-offered means a frame offered to a subscribed authenticated
stream, never proof that WeLink displayed it.

Schema-1 rows migrate lazily on access and persist with the next normal save.
`legacyStatus` and original routes remain. Old submitted-user rows become
unconfirmed legacy-classification observations, not reconstructed external frames.
Existing pending output IDs remain usable by their owners. Newer unsupported
schema versions fail closed. No historical audience ledger is rewritten and no
production history is inferred from incomplete runtime evidence.

- `read_turn_output({outputId})` / `submit_turn_output({outputId,target,botId?})`
  operate on the executing Bot's exact saved text. Same output/target returns the
  stored receipt; an unknown outcome is never blindly resent.
- `delegate_turn_output({outputId,chiefId})` grants one current Main Bot access to
  one pending output. Its exact `authorizationId` must accompany delegated reads
  and submissions. The grant remains available for receipt replay after settlement;
  it is not a team-wide right. Private Bot disclosure uses native owner approval.
- `decline_turn_output({outputId})` intentionally keeps an unsent owned draft
  private; it cannot erase a confirmed send or an unknown attempt.
- `list_turn_outputs` lists only owned or explicitly delegated pending metadata.
  Next-turn prompts offer at most five IDs, with no quoted draft body. Prompt
  construction does not consume the offer; actual ordinary assistant output does.
- Human `submit-turn-output` returns `OUTPUT_BOT_SUBMISSION_REQUIRED`.
  Human `read-turn-output` reads only an already explicitly published recovery.
  User roster carries counts only, never pending bodies/heads/output IDs.
- Normal user turns retain their original route. `reply_to:"user"` is a directed
  request authorization, represented by a host-observed publication interval for
  the canonical feed. It is not inherited by a subsequent reply or child work.
  Scheduled output may explicitly call `publish_turn_to_user` before writing.

Automatic local returns reserve a persisted chain receipt before delivery. The
same sender/request cannot double-submit, conflicting text is deferred, and an
uncertain prior attempt is not replayed. The shared causal-chain maximum is 32
automatic returns; exhaustion records `LOCAL_REPLY_BUDGET_EXCEEDED` on private
pending output. It sends no automatic failure/acknowledgment to the other Bot.
Successful receipts mean durable local admission, not model completion. Existing
explicit `message_bot` request IDs and federation's explicit-send, decline and
causal-budget paths keep their own semantics. This change does not auto-forward
remote final prose or bind a remote Session to a local user chat.

## Validation and boundaries

Regression coverage includes both reply aliases, legacy user work, schedule
classification, a mutable-audience/storage race, unknown live text/stream refusal,
normal user answers, directed user requests, explicit publication, automatic work
return receipts, simultaneous visibility/delivery facts, failed/unknown storage,
private owner/Chief authorization, idempotency, persisted pending output and failed
model-request reminder consumption. Native validation uses DSH 0.2.1-rc.4, mock
models, isolated profiles and a browser; it does not touch installed DSH or user
profiles. Exact command results are recorded after verification below.

External MCP `welink_send` calls and arbitrary gateway subscriptions do not pass
through this feed policy. Gateways must consume authenticated canonical
`/api/bot/user-output`, deduplicate `outputId`, and bind the target user explicitly.
Missing routing is denied in the reference policy. Disconnect replay, external
message ACK and cross-channel idempotency are still separate work. Previously
exposed frames cannot be retracted. Disk/transport uncertainty is discoverable and
recoverable through private dispositions, not a guarantee of exactly-once delivery
in an external messenger. Pending evidence/receipts are intentionally retained;
no automatic deletion policy discards unresolved private outputs or causal IDs.

Verified 2026-11-16 on isolated Linux profiles, DSH 0.2.1-rc.4, mock models:

- Full plugin suite: 2,273 tests, 2,268 passed, 5 skipped, zero failures.
- Generated client build check and lint passed (existing lint warnings remain).
- Native local team smoke: all 52 steps passed, including request/work return,
  part switches, condensation, groups and capabilities.
- Native browser + canonical feed: only authorized reports appear live; no private
  draft controls; model-side original-text submission and actual replay receipt
  preserve one recovered output; zero browser errors.
- Native two-instance late consultation: an unpublished local responder saves its
  long reply; the original remote Session resumes and publishes explicitly.
- Native missing-Session recovery: original activated input is admitted and
  answered once; a real Host restart preserves the repaired binding and later @.
- Windows, real model providers and a production WeLink gateway were not exercised.

Back up the plugin artifact and its local state/ledger before deployment. A rollback
to an older implementation does not retain the new routing guarantees; never mix
old/new Hosts against one profile. Use the source commit to distinguish V0.4.1 artifacts.

Version remains V0.4.1. Deploy a freshly built plugin artifact and restart its DSH
Host; no Hub reset, Hub source update or DSH upgrade is required. The design does
not claim that every reported historical WeLink frame used the canonical route.
