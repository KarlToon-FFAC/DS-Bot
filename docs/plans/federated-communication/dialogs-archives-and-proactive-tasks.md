# Communication dialogs, private archives and independent Bot tasks

The user requested six interface fixes and supplied concrete Hub evidence for a
second proactive Bot message being suppressed in both groups and Bot-only DMs.

## Interface decisions

- Hub forget/leave, contact removal, user-code rotation, member removal, ownership
  transfer, group leave and dissolution have standalone confirmation dialogs.
  They name the object and impact before mutation. Errors remain inside the dialog;
  repeated submits are disabled while the request is running.
- Group settings and inviting a member use separate dialogs. The invite action is
  in the group settings footer, so a long member list cannot push it out of view.
  The invitation picker groups published Bots under nonselectable Human contacts.
- Future complex communication suboperations use `CommunicationDialog`, rather
  than appending a confirmation to a scrolling parent. Native dialog top-layer
  placement escapes parent clipping and makes the background inert. The body
  scrolls independently of the header and action footer. Escape/cancel close the
  topmost dialog, and focus returns to its trigger. Closing animations and reduced
  motion are supported.
- Group members are grouped by canonical Human ownership. Each Human and each
  second-level Bot has one collapsed row; expanding a row exposes its editable
  role, speaking permission and removal action. Unknown ownership is shown as
  unavailable, never guessed from names or IPs. Existing authorization is unchanged.

## Private chat archives

Ordinary communication DMs and owned Bot-to-Bot records can be archived. They are
removed from their normal lists and collected in **Archived private chats**, where
the owner can open or restore them. Incoming messages do not automatically restore
a chat. Archive means a local display preference: it does not leave, delete,
acknowledge or pause the conversation. Bot-only records remain read-only.

The queue stores conversation IDs in an additive `archived_conversations` table.
The list survives browser/Host restart and is scoped to the current Hub's local
queue. `set-conversation-archived` validates the current Hub/instance scope, exact
local Human or owned Bot DM membership and epoch, and read-only configuration.
It rejects groups, foreign Bots and stale epochs. No Hub outbox operation or shared
metadata is created. CLI supports the same read/write contract.

## Complete reply-chain context

The queue already returns the authorized root, ancestors and sibling replies. The
small reply window previously applied another descendant-only filter around the
clicked reply, hiding the original `@all` message and other responders. Its compact
chronological view now retains the entire returned chain, highlights the selected
message, and keeps the reply composer targeted to that exact selection. Pagination,
stable watermarks, membership history boundaries and unrelated-root isolation stay
in force.

## Rejected mention sends must unlock

The exact report was `@贝塔 你收到@你的消息了吗`, followed by Enter and
`UNKNOWN_MENTION`. Unknown `@` embedded inside prose is now literal text; actual
members and explicit recipient tokens still use exact directory validation.

The lock was caused by retaining the immutable pending-send intent on **every**
failure. A definitive rejection now clears that pending intent while preserving
the draft and reply context, so the user can edit, navigate and send a corrected
message with a new ID. An uncertain network result still retains its original
intent and ID for safe retry. Main and thread mention suggestions also dismiss
on composer exit without consuming a click or moving focus.

The reported error text is emitted by the communication send path. Basic local
DSH group navigation with an unfinished `@` was separately checked, including
idle time, Escape, narrow layout and returning from another browser page. The
concrete rejected-send regression, rather than an unproven DSH change, is the fix.
No DSH package is patched.

## Independent proactive tasks

Previously, a Bot publish without a delivery grant borrowed the latest Human root
or `genesis:<conversationId>` and the latest incoming AI message as its parent.
That incoming parent stayed unchanged after the Bot sent a message. Its next
proactive send reused `(parent, author, target)` in `bot_dispatches`, permanently
suppressing a second task; a Bot-only DM also shared one lifetime depth/budget.

A Bot message with no reply target, remote causation/response grant, supplement or
explicit local-user input marker now starts `message:<messageId>` at depth zero
with no parent. Its dispatch key and budget belong to that new message. A reply
without a grant follows the actual referenced canonical parent's root and depth.
An explicit remote grant remains authoritative even without a visible reply
reference. Automatic finals, remote-context tool sends and known local-user inputs
retain their existing per-input semantics, duplicate suppression and finite budget.
Replaying the same message ID returns the original ACK without another delivery.

The Hub advertises `proactive-bot-roots`; the plugin refuses these independent
tasks against an older Hub, including queued tasks after downgrade. Both sides
must be updated/restarted. Existing message hashes, genesis records and ACKs remain
intact, and no reset is required. Already accepted suppressed messages retain their
original results; a new legitimate task must use a new message ID.

## Verification

All model-driven verification uses isolated DSH profiles and deterministic Mock.
No real model key, production Hub or user DSH data is involved.

- Plugin regression: 2,014 tests, 2,009 passed, five skipped, zero failures.
  Hub regression: 185 passed, zero failures. Lint and generated-client consistency
  passed.
- Queue reopen and API tests for archive persistence, independent Hub scope, exact
  membership/epoch checks and unchanged message/delivery state.
- Real WSS Hub and two DSH instances: archive survives Host restart and is restored
  through the actual CLI; the existing full reset/re-enrollment acceptance remains
  green (17 scenarios).
- Real Hub and two DSH instances with an additional local coordinator Bot: two
  successive **local Bot team messages**, without Human-intent or remote-delivery
  fields, each dispatch a group task and then two tasks to the same Bot DM. Every
  peer wake and reply is verified. Existing automatic depth-eight termination,
  34 duplicate burst suppressions, crash recovery and duplicate delivery checks
  still pass (13 collaboration scenarios).
- Hub regression includes 40 independent tasks in one Bot-only DM, an exhausted
  legacy genesis record, a new task after an exhausted chain, same-message replay
  after disk restart, and actual-reply deduplication.
- Chromium production components/styles at desktop and narrow sizes: standalone
  confirmations above a long Hub list, visible action footers, nested member rows,
  invitation dialog, archives, full reply-chain context, the exact Chinese rejected
  send, preserved draft and subsequent navigation/send. No page errors.
- Native DSH Mock smoke covers the standard 52-step team workflow. All owned
  benches and acceptance topologies are stopped after verification.
