# V0.4.2: outgoing message avatars

Every DS Bot-owned outgoing chat bubble shows a sender avatar beside its right
edge. A sender must not be confused with the Bot dispatch/reading row underneath.
The remote timeline uses two grid columns: message and metadata on the left,
authorized sender avatar on the right. Apply the same layout to locally queued
messages and accepted history; preserve current profile revisions and profile
inspection. Bot recipients remain a separate row, never the sender identity.

Local chat, steering messages, earlier parts, local group user messages, plain
answered messages and side questions use the same default human avatar. There is
no configured local Human profile in these renderers, so do not borrow a Bot's
portrait or invent a remote identity. Remote chat retains the configured Human
profile and directory/member fallback; no per-message profile request is added.

No routing, publication, unread, dispatch, server, schema or protocol changes.
Retain current package versions while preparing the V0.4.2 batch.

Validation uses the production React components and CSS in a synthetic browser
fixture: outgoing accepted/queued avatars beside bubbles; local short/long messages
and side questions; desktop and 390px mobile; four themes, light and dark, with
existing reply-quote contrast checks and no horizontal overflow. Screenshots and
evidence stay under the ignored `.dsh-test-tools/quote-contrast-ui` directory.
