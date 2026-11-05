# One active Hub with retained isolated profiles

User decision: retain each Hub separately and permit returning to it, with only
one active connection. This does not authorize moving, deleting or switching
the user's real or current playground databases during development.

## Identity and storage

Existing enrollment records without a queue namespace keep the legacy
`communication.sqlite`; it is never moved or rewritten by profile selection.
Additional Hubs use a deterministic, validated Hub-ID-derived queue namespace.
Each namespace has its own instance ID, Human principal/user code, publication,
contacts, memberships, events, outbox, cursor and model-session bindings. Device
signing keys and scoped CA remain in distinct existing SDK records. New lifecycle
records use a version rejected by older clients, preventing rollback from
ignoring pause/namespace metadata and reopening the wrong queue.

The operator selects a target while communication is disabled, then explicitly
joins or resumes it. Selection alone never sends an enrollment proof or restores
queued messages. Returning requires confirmation that retained work/outbox may
resume; current Hub authorization is checked again. A Hub administrator's revoke
still requires explicit repair/re-approval and fresh group grants as applicable.

## Disconnect, removal and switch

`disconnect-hub` is a local pause: stop transport, durably retain the exact Hub
binding/configuration, then disable it through the documented Config Editor. It
does not claim to delete Hub-side identity, user code, contacts or memberships.
Remote peers see the device offline. This intentional retention enables return.
Hub-side removal is the separate administrator revoke operation; it must never
be disguised as local disconnect or auto-repair after reconnect.

`switch-hub` explicitly selects a different reviewed code or an already saved
Hub. Preserve current configuration first, fence its transport, and install only
the selected disabled configuration. A new Hub gets a fresh signing identity and
queue; an existing Hub keeps its previous identity and queue. A subsequent join
or confirmed resume enables it. No old pairing environment name, credential,
publication scope or trust is copied to a new Hub.

Saved status reads of paused enrollments must not auto-enable communication.
Failure before/after configuration edit leaves the profile paused and recoverable
with the original identities and request IDs. Concurrent selection changes must
reject stale writes. Cross-provider writes cannot be advertised as one database
transaction; durable pause markers and disabled selection fence intermediate
states. Tests must interrupt each boundary and inspect the actual result.

## UI and Agent boundaries

Saved-Hub list, explicit local disconnect, select, join/status and confirmed
resume are available in connection settings and authenticated Human CLI. Hub
administrator actions use a separate operator CLI/site and private credential
input, never password arguments or Bot prompts. A Bot cannot borrow the local
Human or admin identity. The operation matrix must state these distinctions.

Browser drafts, pending operation IDs and closed-conversation choices must be
namespaced as well. The legacy queue may retain its existing keys for compatible
draft recovery; new Hub queues use Hub-qualified keys. Avatar caches must clear
and fence in-flight results across Hub changes, even for identical claimed
principal IDs and image revisions. No old Session or pending callback may send
into the newly selected Hub.

Explicit forgetting/credential deletion is distinct from disconnect and is not
automatic. Retained credential/trust data remains protected by the configured
SDK provider and its documented OS-user access boundary. No global TLS trust,
firewall change or production migration is part of this work.
