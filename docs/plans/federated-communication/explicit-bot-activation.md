# Explicit Bot activation and reply branches

## Problem and protocol boundary

Automatic final exports previously ran body text through the same mention parser
as an intentional Human send. A summary repeating a name or @all therefore became
a fresh handoff. Local groups (`groups.js`, member batches, per-turn target deduplication, work
return barriers) provide useful scheduling precedents, but they use local Bot IDs
and process state; they are not authorization for independent remote instances.

`mentions` now remains the display annotation. For Bot-authored envelopes only,
`activationTargets` is a separate required list of exact member Bot principals.
An empty list means no group Bot activation, including when the body repeats @all,
one name, quotes, or a reply reference. Human @ parsing and direct reply targeting
are unchanged. An active Bot send tool supplies explicit targets (the existing
explicit `mentions` argument remains an alias), allBots, or an explicit reply
reference which the client resolves through authorized canonical history.

A passive Bot still cannot use the send tool. It calls
`set_communication_reply_targets` with the exact current input Message ID and
target IDs/allBots, then completes its normal final response. This only stages
intent in the private durable queue, bound to the current authenticated delivery
and binding. The final consumes the same single-use response grant. No extra send,
new proactive permission or client-selected sender/delivery identity is introduced.
Conflicting restaging fails; identical restaging is idempotent. Revocation and
current membership are checked again by the Hub at actual acceptance.

Both peers require the `explicit-bot-activation` capability before registration,
polling or outbox publication. Upgrade Hub and all participating clients together.
An older Hub/client is rejected explicitly rather than guessing whether body @
was intentional. Existing accepted message bodies and IDs are immutable; history
replay never recomputes deliveries. Unaccepted legacy Bot outbox entries without
structured intent fail explicitly and are not silently rewritten/reissued.

Hub and private queue databases upgrade to schema v3 while preserving identities,
accepted history and pending intents. The previous binaries refuse v3 before
modifying it, preventing a downgrade from silently parsing new Bot outbox text
under the old routing rule. Back up stopped Hub/client databases before upgrade.
Rollback means restoring the matching pre-upgrade backup with the matching old
binary; do not edit version markers or replay new outbox intents through old code.

## Scheduling, durability and permissions

The Hub authenticates the connection and principal, current membership epoch,
speaking mode, exact reply/cause grant, and each current Bot target. Display labels
never authorize routing. Stable IDs retain payload hash conflict checks and retry
ACKs. A transactional dispatch ledger deduplicates a Bot's same target for the
same causal input, across concurrent sends, new message IDs and Hub restarts.
A newly delivered work result has a new input identity, allowing useful
Human -> A -> B -> A continuation. Existing depth and root fanout budgets remain
the final safety bound; whitespace-only handoffs are rejected. We do not infer
work completion or forbid collaboration by matching words like “thanks”.

DM behavior retains its existing canonical recipient routing and causal bounds.
This change addresses group mention reactivation. Local groups keep their existing
member batches, tool scheduling, result barriers and permissions; no DSH patch.

## UI comparison with the original local group

Inspected `user-message.js`, `mark.js`, `group-settings.js`, `communication-list.js`
and `communication-message.js`. Existing remote equivalents already reuse the
original mark/avatar, overlapping group-avatar layout, inline avatar/name mentions,
Markdown primitive, theme tokens and canonical Bot-start row. Remote settings
preserve the card layout and one explicit save, with server-authoritative roles.

This update makes reply chains actual nested branches with continuous vertical
rails and elbow connectors, independent branch collapse and retained parent
excerpts. Collapse is view-only and is available to read-only members too. Deep
nesting stops consuming extra horizontal space after four levels so long messages
remain readable on narrow screens. Parent references preserve the exact relation.
Remote identity inspection, WSS enrollment, per-member speaking modes and Hub
administration remain remote-specific. Local machine permission presets, workspace
access, “everyone answers in turn” scheduling and local admin privileges are not
copied to remote groups. No new remote machine access is granted.

## Verification

- Plugin: 1638 passed, two existing skips (1640 total); generated-client freshness
  and lint pass (existing warning set retained).
- Hub: 94 passed, including strict production WSS, legacy rejection, legacy
  accepted ACK replay, input/target dedup through restart, aggregate/depth limits,
  revoked grants, receiving policy and schema upgrade/future-version refusal.
- Real DSH A/B plus Hub, local Mock only: ten collaboration cases in
  `.dsh-test-tools/bot-collab-9804c3ee-acceptance.json`; passive Human->A->B->A,
  plain single/@all/quoted restatement without activation, explicit active tools,
  explicit all-Bot handoff, depth-eight termination, 35 same-target calls producing
  one dispatch, after-export crash and duplicated authenticated delivery recovery.
- Seven real A/B reply-chain/roster/policy cases in
  `.dsh-test-tools/reply-chain-f063e16b-acceptance.json`; fixtures cleaned up.
- Actual Chrome desktop and 390x844 viewport: nested rails and elbows, independent
  child collapse (sibling stays visible), expand, exact Reply actions, read-only
  thread viewing/collapse with no composer. Four authorized messages, two branch
  lists, 1px connector, no horizontal overflow at 390px (thread width 292px).
  Temporary viewport override reset and owned tabs closed. Synthetic screenshots
  are `.dsh-test-tools/reply-branches-{desktop,mobile,mobile-collapsed,readonly}.png`.

Tests use synthetic data and local Mock models only; same-host A/B is not a
cross-physical-machine result. Real-model handoff decisions, Internet WSS
deployment and external-machine CA configuration are outside this acceptance.

Additional schema-v3 live-browser acceptance:
reply-chain-c4b88805 (evidence in .dsh-test-tools/reply-chain-c4b88805-acceptance.json)
ran all seven A/B cases. At 390x844, the actual 2236-character nested thread has
four message cards and no horizontal overflow; collapsing the long child leaves
three cards and the sibling visible. Screenshots are
.dsh-test-tools/reply-branches-mobile-long.png and
.dsh-test-tools/reply-branches-mobile-long-collapsed.png. Browser viewport reset;
owned tab closed. Test data is synthetic.

Public synthetic screenshots: [desktop](screenshots/reply-branches-desktop.png),
[390px branches](screenshots/reply-branches-mobile.png),
[390px long reply](screenshots/reply-branches-mobile-long.png).
