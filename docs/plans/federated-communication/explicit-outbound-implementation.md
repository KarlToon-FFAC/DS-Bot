# Explicit outbound replies and bounded Bot dialogue

This implements the approved [design](explicit-outbound-and-dialogue-control.md).
Plugin and Hub release numbers remain **V0.3.1**. Update the Hub and both client
plugins to use the complete behavior; restart the owned hosts after installation.
No DSH implementation, production data or external messaging gateway was changed.

## Shipped behavior

- A remote Session's closing prose stays in the local journal. It never becomes
  a network message, including after tool rejection, uncertainty or restart.
  The isolated prompt explains the audience boundary and does not require an
  acknowledgement or a public final.
- `reply_to_communication {text, activationTargets?}` explicitly sends only its
  supplied public text. The host derives the author, exact input, conversation,
  membership epoch and causal grant. Passive and active Bots can consume their
  own reply grant once; this grants no proactive or other-conversation authority.
  `send_contact_message` remains the active Bot's explicit send/attachment path.
  Staged targets alone no longer publish final prose.
- `decline_communication_reply {}` finishes that exact input without a message.
  A completed remote turn with no send also creates a no-reply decision. Its
  idempotent `noReply` receipt records `bot.work.completed` with `outcome:no_reply`
  and cannot activate another Bot. The conversation displays a small completion
  status. Later reply publication/input supplements for that completed grant
  are rejected; a pending explicit send remains pending, not completed.
- A Bot DM request activates its peer. Its exact result can resume the requester
  once. A reply acknowledging that result does not implicitly reactivate the
  peer. A useful explicit follow-up names activation targets and continues the
  same root. Existing duplicate, depth and root delivery limits still apply.
  This is structural routing; it does not classify the meaning of arbitrary prose.
- Local delegated work keeps its root audience. Internal reply turns are hidden
  using durable `turnAudiences` metadata as well as the existing UI projection.
  A result of genuine user work can resume the user answer. Internal inputs
  mixed with user work do not silently acquire mirror permission in either order.
  Local delegated work completion is preserved; it is not blindly disabled.
- The first queue upgrade quarantines uncommitted legacy automatic Bot exports
  with `LEGACY_AUTO_EXPORT_QUARANTINED`. Proven explicit-tool and Human intents,
  accepted history and identities remain intact. Published messages are not
  retracted. Do not bulk retry quarantined messages as new intents.

## Operator audit

The authenticated local `/api/communication` operation `routing-audit` accepts
an optional integer `limit` (1–200, default 50). The installed CLI supports:

```sh
printf '{"limit":50}' | dsbot-remote routing-audit --json
```

Use the CLI's existing local URL/cookie configuration; never place a cookie in
argv. This operator read requires an initialized communication runtime. It
returns decisions and quarantine IDs, exact source delivery/binding, principal,
conversation/epoch, origin/audience, output sequence/ID where available, text byte
length/SHA-256, explicit message ID and current transport result/error. It does
not return closing prose. `pending`, `accepted`, and `failed` remain distinct.
A no-reply receipt means computation completed without public content; it is not
proof of the truth of a remote result (the separate deferred D4 issue).

## WeLink integration boundary

The plugin provides an authenticated local SSE endpoint:

```text
GET /api/bot/user-output?botId=<exact-local-Bot-id>
```

It uses the normal DSH connection authentication. Subscribe only for the Bot
bound to the external recipient. After `hello`, `user-output` records contain
`{botId, sessionId, outputId, item}`. `outputId` uses the Session event sequence
and text-block index for consumer deduplication; `item.routing` includes the
host-derived audience/origin/protocol. Only `audience:user` Bot text with a known
sequence is emitted. Internal/unknown/mixed internal turns, raw user messages,
streaming deltas and remote Session closing prose are excluded. This is a live
feed, without history replay or a delivery-acknowledgement protocol.

**The WeLink adapter is not in this repository.** Its owner must replace raw DSH
assistant-final subscriptions with this endpoint, retain the exact recipient
binding and deduplicate `outputId`. Existing consumers that continue to read raw
Session journals can still read internal text; this commit cannot retrofit their
filtering. The plugin's own UI/feed and durable history projection do honor the
new audience metadata. Internal journals remain available to the local owner.

## Capability and rollout

The Hub advertises the additive `explicit-bot-dialogue` capability. Updated Bot
sends and no-reply receipts to a Hub lacking it fail precisely with
`EXPLICIT_REPLY_CAPABILITY_REQUIRED`, rather than sending under incompatible
semantics. Human operations and compatible GUI-only version differences retain
the existing negotiation behavior. On a newer Hub, older clients still have
legacy exporter code, so install the updated plugin on every participating
instance. Private finals on an updated client remain private even when its Hub
cannot yet accept explicit Bot sends.

## Verification

The regression cases cover pending/rejected sends without fallback, exact reply
scope, no-reply source forgery/idempotence, upgrade quarantine, bounded DM
request/result/ack/follow-up, metadata-only audits, canonical status rendering,
local work audience inheritance, mixed inputs in both orders and mirror feed
exclusion. The Mock model deliberately writes `LOCAL_CLOSING_CANARY` after
explicit remote tools; assertions inspect actual Hub records for its absence.

`ds-bot/dev/communication/explicit-dialogue-acceptance.mjs` starts two real
isolated DSH hosts with Mock models and one owned Hub. It verifies a Bot DM has
exactly two messages/two AI deliveries, passive no-reply is control-only, passive
A→B→A follow-ups use explicit tools, metadata audit contains no private canary,
and restart produces no automatic export. All owned processes close in `finally`.
The existing native work scenario also verifies file/Shell tasks and local
approval continue to work when their result is sent explicitly.

Final verification on this branch (Linux, Node 24, DSH public plugin APIs):

| Check | Result |
| --- | --- |
| Plugin unit suite | 2,114 cases; 2,109 passed, 5 skipped, 0 failed |
| Hub unit/integration suite | 201 passed, 0 failed |
| Native local-team Mock smoke | All 52 steps passed |
| Explicit dialogue, two native DSH hosts + Hub | 4 cases passed |
| Existing Bot collaboration, migrated to explicit tools | 13 cases passed, including duplicate socket delivery and crash recovery |
| Native file/Shell and local approval | 8 cases passed, including directory change and read-only rejection |
| Recovery matrix, isolated remote model calls | All 6 checkpoints passed; no duplicate reply or admission |
| Client bundle freshness / lint / whitespace | Passed; existing lint warnings remain |

Recovery probes now count both binding exports and explicit tool exports for
that exact binding's Sessions. They pause at native `after-output` rather than
requiring an automatic-final export that no longer exists. Model-call assertions
exclude unrelated Main Bot initialization after restart. A durable terminal
private-output decision also permits safe workspace/segment rotation; an
unsettled send or an interrupted turn without such a decision remains blocked.

These runs used only owned test profiles and deterministic Mock. They do not
prove physical Windows/cross-machine deployment, real-model behavior, or the
external WeLink adapter's subscription change.
