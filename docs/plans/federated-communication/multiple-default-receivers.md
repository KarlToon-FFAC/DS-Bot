# Multiple default receiving Bots in a remote group

The user requested that multiple configured Bots receive group messages. Extend
the existing default rule to a set of exact current Bot identities. Keep release
V0.3.2 until a separate upgrade is requested.

An unmentioned Human message activates all selected eligible Bots. Explicit
mentions or a direct reply retain their current targeted precedence. Bot outputs
continue to use explicit activation targets; default receivers never broadcast
Bot results or acknowledgements. Existing per-root delivery/depth limits apply.

Only the group owner/admin can edit this rule, with existing membership/version
checks and idempotent operations. Preserve atomic title/policy/routing saves.
The GUI uses a separate multi-select dialog grouped by the owning contact, then
stages the change for the group sidebar's common Save. Cancel preserves the
original selection. No available Bot or an empty selected set cannot silently
be saved as an enabled default rule; Mentions only explicitly clears defaults.

Canonical reads expose defaultBotPrincipalIds; the legacy adminBotPrincipalId
remains the first selected identity for older readers. Persist the set alongside
the old singleton, and load existing singleton configurations as one-element
sets. Never restore a removed identity when it is republished. Leaving/removal,
retirement, revocation/departure and permanent device deletion remove only the
affected defaults and preserve other valid recipients. Removing the last one
returns the group to Mentions only; dissolution clears the set.

Negotiate the additive multi-bot-default-receivers Hub capability. A new client
can still configure one default on an older compatible Hub. Multiple defaults
on an old Hub fail with a precise upgrade requirement before enqueue/publication;
never silently downgrade to one Bot. Keep GUI-only release differences compatible.
Update CLI schemas, Bot tools, prompts and packaged operation documentation.

Verification must cover real canonical deliveries to multiple passive Bots,
mention/reply precedence, no activation on untargeted Bot output, transactional
validation/rollback, permission/version failures, lifecycle pruning and legacy
restart persistence. Add a two-instance native DSH + Mock scenario proving both
selected Bots receive and can explicitly answer one Human input without a loop.

## Implementation and validation

The Hub stores the canonical set in the additive conversations.default_bots
column and retains admin_bot as the first selected identity for compatibility.
No reset is required. Existing schema-v6 singleton databases reopen as one-element
sets; both singleton and multi-selection survive restart. Configuration changes
apply to subsequent messages and never replay earlier history as model work.
The Human default dispatch still consumes the existing per-root AI delivery
budget; changing receiving rules grants no extra budget or speaking permission.

The shared client operation adapter emits the legacy wire shape for zero/one
receiver regardless of negotiated capability, keeping uncertain retries stable
across connection changes. Multi-selection requires the additive capability
before enqueue/RPC and again when a saved outbox is drained. An accepted operation
still returns its saved result if the connected Hub subsequently changes capability.

Verification on owned Linux fixtures with deterministic Mock:

| Check | Result |
| --- | --- |
| Plugin full suite | 2,119 cases: 2,114 passed, five existing skips, zero failures |
| Hub full suite | 206 passed, zero failures |
| Native two-DSH/Hub test | Four scenarios passed: two passive replies, exact mention, exact direct reply, prune-one/retain-one |
| Chromium desktop and 390px | Separate dialog, owning-contact groups, multi-selection, one atomic save, no clipping/browser errors |
| Native local-team smoke | All 52 steps passed |
| Lint and generated client freshness | Passed; existing warnings remain |

Native harness: `ds-bot/dev/communication/multiple-receivers-acceptance.mjs`.
Browser harness: `ds-bot/dev/communication/multiple-receivers-ui-acceptance.mjs`.
These use only owned temporary profiles/synthetic identities, not production
accounts, user journals or API keys. Physical Windows/cross-machine and real-model
behavior are not newly claimed by this change.

[Desktop selection](screenshots/multiple-default-receivers-desktop.png) ·
[Mobile selection](screenshots/multiple-default-receivers-mobile.png).

Receiving does not force a reply: each selected Bot retains the explicit reply/
no-reply tools and the local-final boundary introduced in the preceding fix.
