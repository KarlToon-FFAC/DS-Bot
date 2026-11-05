# Connection and synchronization reliability

This implementation keeps `dsbot-communication/1` and the durable queue schema.
Testing-stage data may be reset, but neither a protocol bump nor a new database
format is needed to fix these races. See `test-hub-reset.zh.md` for the separate,
explicitly destructive test-data reset procedure. This implementation never
resets data, silently reenrolls a revoked device, or restores revoked membership.

## Evidence and design choices

- [Matrix syncing](https://spec.matrix.org/latest/client-server-api/#syncing)
  separates incremental synchronization, continuation tokens and limited-history
  gaps. DS-Bot keeps per-principal, per-membership-epoch contiguous sequence
  cursors instead of an opaque global token: these are also its read-permission
  boundary. A socket handshake is not completed synchronization.
- [Matrix JS SDK durable sync transaction](https://github.com/matrix-org/matrix-js-sdk/blob/cc4ae934887a7157452dc332d5de0383197c98c8/src/store/indexeddb-local-backend.ts#L440-L459)
  stores the sync token with room data. DS-Bot already inserts events and advances
  the contiguous cursor in one SQLite transaction (`CommunicationQueue.applySync`
  and `receive`). Replacing this working atomic boundary would add migration risk
  without improving correctness. A gap remains a failure; it cannot advance ready.
- [XEP-0198 acknowledgement](https://xmpp.org/extensions/xep-0198.html#acks) and
  [resumption](https://xmpp.org/extensions/xep-0198.html#resumption) distinguish
  responsibility for delivery from user read or completed application work.
  DS-Bot retains stable message/operation/delivery IDs and its separate Hub
  acceptance, target-stored, UI-applied, human-read and AI states. Reconnect never
  regenerates an outbox ID or assumes model/tool effects are exactly-once.
- [XEP-0313 archive synchronization](https://xmpp.org/extensions/xep-0313.html#business-sync)
  explicitly allows overlap between live and archived delivery. DS-Bot's new
  push channel deliberately carries only invalidation, not a second event log.
  Authoritative data still flows through membership-checked RPC and the existing
  event-ID/hash, delivery-ID/hash and continuous-sequence deduplication path.
  [Query identity checks](https://xmpp.org/extensions/xep-0313.html#security)
  motivate binding each response and asynchronous continuation to its originating
  socket and local generation, not merely to the currently selected Hub.

These are design comparisons, not claims that either protocol guarantees
application-level exactly-once execution. No external source code was copied.

## Layers and invariants

1. **Transport ownership.** A local generation fences credential loading, socket
   creation, authentication, RPC results and asynchronous callback requests.
   Stop rejects outstanding RPC immediately. An old promise cannot mark a new
   connection ready, close it, send through it, or schedule its retry loop.
   The run generation independently owns timers. Runtime disposal captures and
   awaits the old in-flight tasks before closing SQLite.
2. **Authentication versus synchronization.** States are idle, connecting,
   authenticating, synchronizing, ready, disconnected, backoff, blocked, fenced
   and stopped. `connected` means an authenticated socket; `ready` requires a
   successful complete reconciliation. A revoked membership clears local
   authorization and refreshes that projection without revoking device trust.
   Device `UNAUTHENTICATED` remains terminal; `STALE_CONNECTION` fences this
   owner rather than competing with the replacement instance.
3. **Lossy notification, durable recovery.** `state-invalidation` is optional.
   Only clients advertising it receive `{protocol, type:'state.invalidate', scope}` (directory or messages).
   The frame contains no IDs, names, revisions, content or credentials. It is a
   Hub-level dirty signal and can disclose coarse Hub activity timing; it is not
   a per-conversation subscription or authorization grant. Each subscriber's
   current trust and epoch are checked before notification. If this metadata
   isolation is insufficient for a future multi-tenant Hub, use per-tenant or
   scope-partitioned invalidation, not content-bearing global notifications.
4. **Bounded scheduling.** Hub invalidations coalesce for 50 ms. Client bursts
   collapse into one follow-up reconciliation; there is never a second pump
   started by a hint. Capacity and transport backoff cannot be bypassed by hints.
   The existing periodic pull remains compensation for lost notifications,
   congested sockets, old Hubs and process restart. New connections always start
   with authorization reconciliation and durable catch-up.
5. **Current presence.** Hub presence requires an OPEN authenticated socket with
   the current stored epoch and trusted device. An old socket is not presence.
   WebSocket ping/pong detects half-open peers, by default within two 30-second
   intervals (event-loop delays may extend this). Trust/approval remains separate
   from connected status. No persistent online bit survives a Hub restart.
6. **Presentation invalidation.** Runtime management revision advances on
   connection, meaningful directory changes and directory hints, including contact-request
   changes that do not alter the contact list. The authenticated admin long-poll
   feed is a separate UI-layer integration. UI refresh never expands read scope.
7. **Diagnostics.** Local state and the existing read-only diagnosis endpoint
   expose generation, connection count, hint count, pending RPC count, latest
   synchronization/disconnection timestamps, latest error code and a bounded
   32-event lifecycle history. No payloads, keys, credentials or raw socket reason
   strings are logged. Unchanged steady-state polls do not flood this history.

## Deployment and compatibility

Deploy Hub and clients together to gain hints and presence. An older client
continues RPC polling and receives no unsolicited frame; a newer client still
polls an older Hub. No required capability was added. Presence is unknown in a
UI that talks to a Hub without the field, rather than inferred from approval.
There is no event-delivery migration, global cursor reset or implicit replay of
old model work. Clearing test data is a separate operator choice, not a transport
recovery strategy. Historical read permission remains per principal and epoch.

## Reproducible verification

All tests use synthetic identities, loopback sockets, disposable databases and
Mock models. They do not access a real Hub or call a real model.

- `node --test ds-bot/test/communication-connection-lifecycle.test.js`: deferred
  credentials/socket factories, immediate cancellation, delayed old replies,
  old callback isolation, 100-hint coalescing, old/new loop ownership.
- `node --test communication-hub/test/invalidation.test.js`: real WS hints with
  a 60-second fallback (updates arrive without waiting for it), explicit contact
  consent, legacy/unauthenticated isolation, payload minimization, dropped-hint
  fallback, reconnect catch-up, half-open heartbeat expiry and stale-epoch presence.
- `communication-hub/test/contact-race.test.js` and
  `ds-bot/test/communication-membership-race.test.js`: membership rotation
  between snapshot and sync/ACK, or a newer local snapshot racing sync-page
  application or delivery storage, is scoped, not device revocation.
- Existing `communication-hub/test/network.test.js` covers ACK loss, forced Hub
  death, restart, durable receipt retry, TLS and canonical message recovery;
  `transport-fairness.test.js` prevents capacity backoff from starving inbound
  work or accidentally closing the authenticated socket.
- `node --import ./ds-bot/test/harness-resolve.mjs ds-bot/dev/communication/contact-removal-acceptance.mjs`
  runs two actual isolated DSH hosts with a deterministic Mock, including scoped
  removal, continuing group work, disconnect/reconnect and process restart.

The full plugin suite, Hub suite, generated-client freshness and lint remain
required after integration with the UI and lifecycle changes.


## Immediate targeting after another member accepts

A sender can still hold the previous member list when the remote join operation
has already committed. A locally unknown mention/activation target is therefore
not retried by publishing blindly. Human API sends, Bot tool sends and staged
reply targets perform at most one read of `conversation.members` using the exact
original actor and membership epoch, then repeat only local validation. The
refreshed response must match the conversation/kind, retain the original local
epoch and socket generation, include that actor with the required speaking mode,
and not regress the membership version. Closed/replaced connections, revocation
and changed epochs fail before cache writes or queue insertion.

Existing Human intents and Bot export journals return their original IDs without
this read. A first failed Bot export transaction rolls back before the refresh;
DM opening and other committed operations are not repeated. The candidate Bot
message ID is held across the one preflight retry. Canonically unknown targets
remain rejected, and `@all` still requires the local membership/version projection
to match rather than expanding through an unresolved synchronization gap.
`communication-target-refresh.test.js` covers these cases with disposable SQLite,
including actual Hub acceptance followed immediately by the sender's first send.
