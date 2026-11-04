# DS-Bot communication Hub

This independent Node 24 service stores the canonical communication log and
per-participant deliveries in local SQLite. The client queue and WebSocket
transport are in `ds-bot/src/host/federation/queue-store.js` and `transport.js`.
The default-off production DSH adapter now connects these queues to exact local
Human/Bot identities and ordinary DSH Sessions. The production communication UI,
local A/B Mock acceptance and browser matrix are recorded in the plan evidence
directory. Final security-review evidence supersedes the earlier snapshots.

## Run and stop

```powershell
cd D:/git/DS-Bot-federated/communication-hub
npm.cmd ci --registry https://registry.npmjs.org --offline=false --cache ../.dsh-test-tools/npm-cache --no-audit --no-fund
npm.cmd test
# Set the owner-provided credential environment variables through the local
# secret mechanism, then use a config containing only their variable names:
npm.cmd start -- ./config.example.json
```

`npm test` needs no real account or key. Legacy shared secrets and signing private
keys stay in the test process; isolated databases contain public-key authorization,
consent state and password verifiers. No production credentials are used. It
includes independent Hub/client databases, a forcibly terminated Hub, lost
publish/receipt responses and automatic reconnect.

The CLI reports its actual listening port. `GET /health` returns only readiness
and protocol version. Ctrl+C invokes normal shutdown; a forced Windows process
termination is a crash-recovery test, not proof of graceful shutdown. Embedded
callers use `await startHub(options)` and `await hub.close()`. No service is
installed. Database paths resolve relative to the config file.

## Hub page, device requests and user codes

For a new local Hub with its management page enabled, use
`managed.config.example.json`. Keep your working configuration and database in
the ignored local data folder:

```powershell
cd D:/git/DS-Bot-federated/communication-hub
npm.cmd ci --no-fund --no-audit
New-Item -ItemType Directory -Force ../.ds-bot-local/hub | Out-Null
# Copy only for a new setup; preserve an existing operator configuration.
if (Test-Path ../.ds-bot-local/hub/config.json) { throw 'Hub configuration already exists; edit it instead.' }
Copy-Item ./managed.config.example.json ../.ds-bot-local/hub/config.json -ErrorAction Stop
# Supply DSBOT_HUB_ADMIN_PASSWORD privately in this process (at least 16 characters).
npm.cmd start -- ../.ds-bot-local/hub/config.json
```

The default local page is `http://127.0.0.1:3190/admin/`; the startup log is
authoritative if you change the port or public origin. This starter is loopback
only. For other machines, configure reachable trusted WSS/TLS as described below.
The existing `config.example.json` keeps management disabled for static-peer
compatibility; starting that file alone does not enable an administrator page.
The client exposes **Personal settings (sidebar gear) → Hub management**, with no
permanent Hub link in the sidebar, and uses only an actual management
URL advertised by an enabled Hub. Old or disabled Hubs show setup guidance rather
than inventing a working page. Opening a link does not start the Hub or sign in.

Enable `management.enabled` and supply an administrator password of at least
16 characters through `management.adminPasswordEnv`, using your existing local
secret mechanism. Do not put its value in config or command arguments. The Hub
prints its `/admin/` address. There is no default password, and management is off
unless explicitly configured. `peers` may be empty when management is enabled.

For real devices, configure a reachable `management.url`, for example
`wss://hub.example.test:3190/communication`, with the matching trusted TLS
certificate and existing network routing. `management.origin` can specify the
same-origin HTTPS admin address. The Hub code contains that full address and a
stable Hub ID: it is a locator, not a secret, discovery service or NAT traversal.
Loopback plaintext is for local isolated tests only. This service does not install
certificates, open firewall rules or create a persistent system service.

In DS Bot choose Remote communication → Add a device, paste the code, verify the
displayed address/Hub ID and explicitly request admission. The Hub administrator
checks the applicant and key fingerprint before approving it on the Hub page.
The device proves possession of its private signing key; approval does not send
a shared secret back. The private key stays in that device's DSH credential
provider. Its default provider is an OS-account-protected plaintext file, so do
not mistake it for encryption or isolation from same-user processes. Configuration
contains a credential reference, not the key. Existing configured pairings cannot
be silently replaced with another Hub.

After approval, explicitly select local Bots to publish. Each instance's Human
receives a unique user code. Use Manage contacts to request the other user's code;
both Humans must explicitly confirm their own shared Bot scope (default none).
Codes identify users but never authenticate them or grant administrator rights.
Unknown/unavailable code requests have indistinguishable acknowledgments. Pending
requests expire, and rate limits and single-use signed challenges prevent abuse.

Revoking a contact blocks DMs and new invitations, fences old queued DM intents
and preserves historical data. Existing shared groups keep their separate
permissions. Revoking an instance stops its authentication; explicit repair accepts
only its original key and increases its revision, without restoring old group
memberships. Reconnecting or sharing a public code cannot undo revocation.

The local Human CLI `dsbot-remote` covers these device, contact, profile and
publication operations; run `help` for exact JSON schemas. Administrative CLI:
`node communication-hub/src/admin-cli.mjs --help` from the repository root.
Supply `DSBOT_HUB_ADMIN_PASSWORD` privately for state/decide/revoke/repair/rename commands.
These administrative operations do not belong to a Bot or group owner.
See [management design](../docs/plans/federated-communication/management-design.md)
and the [final acceptance matrix](../docs/plans/federated-communication/follow-up-matrix.md).

## Pairing and transport

Every configured peer is an explicit member of this Hub's trust pool. Credentials
are read from the referenced environment variables and stay in process memory;
they are not included in messages, directories or diagnostics. Only identities
explicitly registered by a paired host are published. A host may register or
act as identities in its own instance namespace. Its Human/Bot ingress must
derive the actual caller locally; a model must never receive the host credential.

Each new connection authenticates before any directory or messaging operation,
checks `dsbot-communication/1` and required capabilities, and takes a durable
connection epoch. An older connection cannot continue writing. Display names
and network addresses never select an author or recipient.

The required `membership-epoch` capability rejects pre-review clients. Every new
publish and group mutation carries the actor's captured membership epoch; queued
intents never acquire a later rejoin's authority. Versioned group changes reject
stale versions. A byte-identical already committed retry returns its historical
ACK without creating new work. Legacy uncommitted intents without an epoch fail
explicitly and remain in the local audit queue; they are never silently scoped
to the current membership.

Removing a peer from config and restarting revokes it durably. Embedded owners
can call `hub.revoke(instanceId)` immediately; this is not a network operation.
Pending deliveries and invitations become revoked, active memberships close,
and a default reply Bot loses that role in the same transaction. Restarting or
reconnecting does not undo revocation. An owner must increase that peer's public
`pairingRevision` in config to re-pair. Group re-entry requires a fresh invitation;
the retained owner can instead explicitly reclaim its own identity. Reopening a canonical DM preserves its ID and establishes a new membership epoch
and history boundary. Old revoked deliveries never return.

Plain `ws://` is accepted only on literal loopback addresses. For a non-loopback
listener, supply `tls.certificateEnv` and `tls.privateKeyEnv` referencing PEM
values; the service uses HTTPS/WSS and normal certificate validation. No TLS
validation bypass, firewall change or cross-machine deployment is performed by
the local tests. The WSS runtime test covers the production client with a temporary
private CA, including rejection of untrusted certificates, wrong hostnames and
wrong credentials. Different-IP operation remains separate acceptance work. See
[the two-machine trial and rollback guide](../docs/plans/federated-communication/two-machine-trial.md).

## Durable behavior

- Schema version 2 is installed idempotently and migrates version 1. Future `user_version`
  values are refused before migration. SQLite uses WAL, `synchronous=FULL`,
  foreign keys and a busy timeout. Keep each database on its owner's local disk.
- A publish transaction validates the authenticated author and current
  membership, checks ID/hash conflicts, assigns the conversation sequence and
  writes the event plus every stable recipient delivery before acceptance.
- The DM key is a sorted JSON array of complete principal IDs with a unique
  constraint. Concurrent reverse opens and retries return the same conversation.
- Invites grant no history or delivery until accepted. Membership epochs and
  `joinSeq` apply per principal, including multiple principals on one instance.
- Routing selects only exact structured mentions. A Human mention never calls
  its Chief. A plain Bot group reply is display-only; a plain Human group message
  uses `admin` or `mentionsOnly`. Removing the admin switches to `mentionsOnly`.
- `group.dissolve` is an idempotent owner-only operation. It atomically ends every
  membership and invitation and revokes unfinished deliveries, retaining the
  canonical log and already admitted work. Local UI closing only changes the
  current browser's visibility; leaving removes only the caller's membership.
- The client commits a full outbox payload before networking. Receiving commits
  the event, individual inbox and pending receipt before acknowledging storage.
  Duplicate delivery, event and message identities are checked independently.
- Projection, read and AI receipt phases are separate. AI work remains gated
  after restart until fresh membership reconciliation and continuous history.
  Unknown injection stays unknown; this transport does not blindly retry DSH.
- Gap events are retained without advancing the contiguous cursor or exposing
  later context. Sync pages and delivery batches preserve whole messages within
  the negotiated envelope limit. Cursor acknowledgments are per principal/epoch.
- Bot-output source mapping, complete outbox payload and export positions share
  one local transaction. Replays reuse the original message ID.

Capacity is explicit in the handshake: text/envelope bytes, members, outstanding
deliveries, registered principals, membership records and pending invitations.
Defaults are in `src/protocol.js`; hitting a limit returns a visible error.
There is no silent truncation, expiry or success before persistence. Client
outbox backpressure is also explicit. Transport failures use exponential backoff
with jitter; protocol, content, authorization and revocation failures stop retries.

The WebSocket request envelope is `{ protocol, id, type, payload }`; replies are
`{ id, ok, value }` or `{ id, ok: false, error: { code, message, details? } }`.
`hello` is first. The server route table lists the directory, DM/group, publish,
membership, sync/cursor, delivery and receipt operations. Credentials never appear
in a URL. DS-Bot adapter/UI and real DSH acceptance are documented in
`../docs/plans/federated-communication/`.

## Group roles and speech

The creator is the sole owner, independently of name, instance or Main Bot label.
`group.policy` assigns admin/member roles and per-kind speaking modes, and
`group.transfer` atomically replaces the owner. Both require `expectedVersion`;
stale updates return `GROUP_VERSION_CONFLICT`. Admins can invite, set routing and
manage ordinary members. They cannot promote themselves, modify another admin
or owner, transfer ownership or dissolve the group. The default reply Bot is a
routing assignment, not a management role.

New Human invitees are `readOnly`; new Bots are `passive`. Creators can speak.
Migration retains old speakers (`speak` / `active`), promotes the earliest active
legacy manager to owner and retains other managers as admins. An ownerless legacy
group is not automatically claimed. Clients missing the required `group-policy`
capability are refused instead of being granted defaults.

A passive final reply needs `responseToDeliveryId`, matching a real stored AI
delivery to that author, conversation, current epoch and reply target. The reply
transaction consumes that grant once with the message and deliveries. Forged
references, repeated grants and old epochs fail. Passive replies cannot activate
other Bots. Queued new publishes use current permissions; same-ID retries of a
committed message return its original result.

An offline owner keeps its identity. Trust revocation removes memberships but
retains the owner ID. After explicit re-pairing, only that exact identity can use
`group.reclaim` to join with a fresh epoch/history boundary. Admins never inherit
ownership automatically; dissolved groups cannot be reclaimed. There is no
impersonation or administrative takeover backdoor.

### Rename an instance

Sign in at `/admin/`, find the instance under **Devices**, edit **Instance name**
and select **Save name**. Only the Hub administrator may do this; group roles and
pairing credentials do not grant access. Names are display metadata: immutable
instance/principal IDs, user codes, memberships, trust and history stay intact.
Connected clients update their contacts and group member labels through normal
synchronization. The name survives Hub restart and static/enrolled reconnects,
even if an old static peer configuration still has the original label.

Administrative CLI `rename` reads an explicitly named JSON file with
`{"instanceId":"...","label":"Office device","expectedNameVersion":0}`.
Use the current `nameVersion` from admin `state`. A competing edit returns
`INSTANCE_NAME_VERSION_CONFLICT`; refresh before deciding another edit. Supply the
administrator password privately through `DSBOT_HUB_ADMIN_PASSWORD`, never argv.
Do not use the Human communication CLI or a Bot tool as administrator authority.
