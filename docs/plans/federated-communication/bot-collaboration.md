# Bot collaboration in remote conversations

This follow-up to 4ed1797 fixes a real mismatch: the Hub already allowed active
Bot tool sends, but suppressed every AI target of passive final replies. The
system prompt reinforced that restriction, so newly invited (passive) Bots told
users they could not delegate. Explicit Bot cooperation is now permitted while
retaining one-response grants, per-conversation isolation and finite server limits.

## Speaking modes

- Human readOnly cannot send; speak can send.
- A passive Bot may produce one final response to its actual authorized AI
  delivery. That response may explicitly @ another current member Bot, local or
  remote, or @all current Bots. It cannot make unsolicited or tool-initiated posts.
- An active Bot may additionally send through send_contact_message. In a remote
  Session the host binds that tool send to its actual durable input, not a model
  supplied actor or thread. In a private local Session it still uses its own
  published Bot identity and current group permission.
- Unmentioned group Bot replies are display-only. Default reply routing is not
  automatically applied to Bot replies. Self mentions never activate the author;
  @all does not activate Humans or non-member published Bots. DMs retain their
  automatic other-participant routing, bounded by the same causal limits.

## Thread and loop protection

The existing responseToDeliveryId remains a one-final-response grant. Tool sends
use optional causationDeliveryId without consuming that final grant. The Hub
checks AI eligibility, stored receipt, actual recipient identity, current epoch,
conversation and revocation. The host derives tool causation only from the tool's
exclusive current-turn durable communication input; mixed/private/old-turn sources
cannot borrow a grant. Default replyToMessageId references that input; an explicit
authorized reference remains intact. Tool source IDs and export journal IDs remain
stable for replay and crash recovery.

The Hub derives, persists and returns canonical event/ACK causality:
`{rootMessageId,parentMessageId,depth}`. Caller-supplied root/depth is not trusted.
A new Human message starts a root at depth0. A Bot child derives its parent from
its grant. A Bot omitting causation does not get a fresh budget: its unsolicited
active post is anchored to the latest Human root in that conversation, or a
stable conversation genesis root. Permission to initiate does not permit unlimited
independent automated roots.

Default Hub limits are maxCausalDepth8 and maxAiDeliveriesPerRoot32. The Human
message's first AI recipients and all branches share the root count. At depth8
or if a whole recipient batch would exceed the remaining root budget, the message
is still durably accepted and readable, but no further AI recipients are activated.
The canonical event/ACK has dispatchSuppressed=CAUSAL_LIMIT, and GUI feedback is
outside chat messages. It is not a transport failure and must not be retried or
re-authored to bypass the bound. A new explicit Human input can continue work.

Counters and ancestry are additive durable Hub tables. Migration reconstructs
old roots and counts from canonical messages and AI deliveries; restart does not
reset a consumed budget. Repeated message IDs reuse their original ACK and do not
consume another grant or AI allocation. Existing normalized payload hashes stay
compatible when optional causation is absent.

## Use and acceptance

Grant active in the existing member permissions UI only when a Bot may initiate;
keep passive for one-response delegation. Human CLI policy changes use the same
Hub role/version checks. Bots use their own tools, never Human CLI credentials.
The packaged dsbot-remote Skill and core prompts explain this distinction.

Run the isolated same-Windows-computer scenario with:
`node ds-bot/dev/communication/bot-collaboration-acceptance.mjs`.
It uses actual DSH A/B and Hub processes with deterministic Mock responses and
synthetic data. Physical cross-machine and paid-model behavior are outside this
run. Final verification results are recorded below after execution.

## Upgrade order

Update the Hub first, then both clients. The Hub advertises
bounded-bot-collaboration while continuing to accept the original base client
capabilities. New clients require the advertised bounded capability before
registration, synchronization or publication. An old Hub produces
BOUNDED_COLLABORATION_REQUIRED with upgrade guidance; existing queued IDs and
payloads remain untouched. Do not change credentials or re-pair to bypass this
version check. The protocol identifier and legacy payload hashes are unchanged.

## Verification results

Final plugin suite: 1542 total, 1540 pass, 2 original skips, 0 failures. Hub suite:
47/47, including real WebSocket legacy-client compatibility and causal migration.
Build/freshness and lint pass. New adapter tests cover actual current-turn tool
provenance, mixed/old/forged input rejection, journal retry and refusal of an old
Hub before registration/publication without changing the queued intent.

The real DSH A/B Mock collaboration scenario passed all 7 cases: Human to passive
A to passive B to A; passive unsolicited denial; active tool text mention with
causal linkage; Bot final @all excluding Human/self/nonmember; depth8 suppression;
35 active tool sends sharing exactly 32 root AI deliveries; duplicate delivery and
after-export crash/restart preserving one input, message ID, parent and grant.
The original remote CLI regression also passed all 8 groups and 24 operations.
Old COMM-ECHO fixtures now quote echoed mentions so they test ordinary replies;
new COMM-COLLAB fixtures deliberately delegate. The real routing is unchanged by
that fixture distinction. These are same-machine Mock results, not physical
cross-machine, real-model or new browser acceptance.

Final fresh capability-negotiated run: 7/7 passed, private evidence
`.dsh-test-tools/bot-collab-e1e9fe59-acceptance.json`; original remote regression
`.dsh-test-tools/remote-im-5dec7f40-acceptance.json` passed 8/8; required native
local-team Mock smoke passed all 52 steps. All owned benches stopped and retained
only ignored synthetic test data. Exact staged publication scan found zero
must-fix findings; credentials, databases, logs and profiles are excluded.
