# Hub administration, enrollment and consent

Implementation baseline: `37738c6`. This design uses public DSH APIs and additive Hub tables. The management UI is served by the Hub itself. It introduces no discovery service, real account requirement or implicit network deployment.

## Public Hub identity

`GET /hub-info` returns `{hubId,url,code}` when the operator configured a reachable communication URL. `hubId` is a persisted UUID. `code` is `dsbot-hub:1:` followed by base64url UTF-8 JSON `{hubId,url}`. The URL includes the full `/communication` WSS endpoint; only isolated loopback development accepts WS. No userinfo, query, fragment or redirect is allowed. A Hub code is public location metadata, never an authentication grant. Clients must retain the selected Hub ID and exact origin and validate TLS normally. A short opaque code cannot locate a machine without a separate discovery service.

## Enrollment wire contract

The existing protocol envelope contains `enrollment.challenge` or `enrollment.prove`. These messages are allowed only before ordinary instance authentication. The server passes the actual socket object as the binding; the client cannot choose it. `forget(socket)` is called on close.

`enrollment.challenge` input:

| purpose | Required input |
|---|---|
| `join` | `publicKey`: Ed25519 public key in SPKI PEM |
| `status`, `cancel` | `requestId` from an earlier join challenge |
| `login` | Approved `instanceId` |

The response is `{challengeId,nonce,hubId,purpose,requestId?,instanceId?,expiresAt}`; time is epoch milliseconds. The Hub generates the join request ID at challenge time. A challenge lives 60 seconds, is bound to one socket, and is single-use even after an invalid signature. The signature input is exactly UTF-8 `JSON.stringify(['dsbot-enrollment/1',hubId,purpose,challengeId,nonce,requestId??'',instanceId??'',expiresAt])`. Ed25519 has no additional digest parameter; signature encoding is base64url. The Hub stores the challenge's canonical public key internally and does not accept a replacement during prove. Login challenges also capture the authenticated pairing revision internally; prove checks the current revision, so revocation followed by same-key repair cannot revive an earlier signed challenge. This revision binding is server-side and does not change the wire transcript.

`enrollment.prove` input is `{challengeId,signature,displayName?}`. Join requires a nonempty device name of at most 100 UTF-16 units. Join/status/cancel response is `{requestId,status,instanceId?}` with `pending/approved/rejected/cancelled/expired`. Login response from the management service is `{instanceId,label}`: the server then calls `store.connect` with the negotiated capabilities and returns the ordinary authenticated welcome. Public approval state does not authorize a login without a fresh proof.

Only successful join proof creates the durable request. Before sending that proof, a client must durably save its private key, Hub binding and request ID. A lost response is reconciled using signed status, never by silently generating a new identity. `JOIN_NOT_FOUND` at status-challenge time explicitly means no durable request with that ID exists; an explicit retry may request a new challenge. Other uncertain outcomes retain the original record. Important errors: `INVALID_REQUEST`, `UNAUTHENTICATED`, `JOIN_NOT_FOUND`, `CHALLENGE_EXPIRED`, `JOIN_ALREADY_PENDING`, `ALREADY_ENROLLED`, `JOIN_LIMIT`, `RATE_LIMITED`.

Pending joins expire after 24 hours. Admin decisions use `{requestId,expectedVersion,action:'approve'|'reject'}`. A stale or duplicate decision reports `JOIN_VERSION_CONFLICT`; inspect canonical state before another decision. Approval atomically creates the instance, public-key authentication entry, one Human `human:<instance UUID>:local-user`, stable 96-bit user code and approved result. The Human can subsequently rename itself using the existing authenticated route. Admins must verify fingerprints with the intended owner; names and observed addresses are untrusted labels.

## Integration boundaries

`new HubManagement(store,{url,now?})` uses the store's SQLite database and transaction boundary. It exports `info`, `peer`, `challenge`, `prove`, `forget`, `joins`, `decide`, `instances`, `rename`, `revoke`, `repair`, `code`, `rotateCode`, `requestContact`, `contactRequests`, `respondContact`, `revokeContact`, `relations`, `filterDirectory`, `assertContact` and `assertDm`.

The base server must:

- Keep dynamic peers in the database across restart. Static-list omission revokes only legacy peers, never `management.peer(id)` entries. Static credentials cannot authenticate an enrolled peer as an alternate path.
- Authenticate enrolled peers only through fresh socket-bound signatures, then use the existing connection epoch and trust checks on every operation. Revoke closes all matching sockets and invalidates trust through the existing `revokeInstance` transaction. An old key cannot restore trust. Re-pair/recovery requires an explicit higher revision, not a new join silently assuming an old identity; retained group ownership follows existing recovery rules.
- Filter `contacts.list` through `filterDirectory(auth,rows,principalId?)`; an explicit actor must belong to the authenticated instance and is the sole authority used for filtering. Omission retains the local Human/host directory view. Bot tools outside a remote binding request their own actor-filtered list; a group-bound Bot sees only its canonical group members. Call `assertContact` inside the new/restore DM and group-invite transaction, and recheck a pending invitation at acceptance. Check `assertDm` after committed duplicate ACK lookup and before every new publication. Recheck DM authorization before model execution/AI receipts; historical reads may remain available to authorized existing members.
- Keep shared-group membership and group-scoped member metadata independent of contacts. Shared groups do not grant directory enumeration or permission to open DMs.

`createManagementHttp(management,{origin,password?,onRevoke})` returns `{handle,close,enabled}`. `handle(req,res)` is asynchronous and returns true only when it consumed the request. The host must await it before its fallback handler. Supply the exact externally trusted origin; non-loopback origins require HTTPS. Supply the normal server revocation function so active sockets close too. Management is disabled without an explicit password or verifier. Temporary test passwords are supplied only in process memory; environment values are not written into the database.

## Human contact wire contract

The local authenticated Human service derives `principalId`; neither GUI nor CLI chooses another author. Bots cannot manage Human consent. Each new mutation has an original operation ID; exact committed retries return only the original result.

| Wire type | Management method / input |
|---|---|
| `contact.code` | `code(auth,{principalId})` returns `{userCode,hubId}` |
| `contact.code.rotate` | `rotateCode(auth,{principalId,operationId})`, returns a new code; old hashes remain tombstoned |
| `contact.request` | `requestContact(auth,{principalId,operationId,userCode,botPrincipalIds:[]})` |
| `contact.requests` | `contactRequests(auth,{principalId})` |
| `contact.accept/reject/cancel` | `respondContact(auth,{principalId,operationId,requestId,expectedVersion,botPrincipalIds?},action)` |
| `contact.revoke` | `revokeContact(auth,{principalId,operationId,otherHumanPrincipalId,expectedVersion})` |
| `contact.relations` | `relations(auth,{principalId})` |

Requests always return `{requestId:operationId,status:'pending'}`, including invalid or recipient-throttled codes. Outgoing rows contain only `{requestId,direction,status,expiresAt,version}` before consent. Incoming rows additionally identify the authenticated `senderPrincipalId` and `senderName`. Rejection is not exposed as a target-existence oracle to the sender: its outgoing status and version remain `pending`/`1` until expiry or the sender cancels. Outgoing versions describe visible state (`1` pending, `2` terminal), while incoming versions track the canonical request record. Cancellation checks the caller's visible state/version, so even a pre-rejection sender view may cancel the request. Explicit cancellation and requests superseded by acceptance or revocation are terminal `cancelled` on both sides, including records created before this fix. Cancellation never revokes an accepted relation; stale competing decisions fail `CONTACT_VERSION_CONFLICT` and must refresh canonical state. Requests expire after 24 hours; all reads and writes enforce expiry independently of timers. The per-sender pending quota counts private rejections until the same visible expiry/cancellation, so rejection cannot be inferred by probing freed capacity. Per-sender, target and global request limits supplement 96-bit random codes and hash lookup. Unknown codes create indistinguishable outgoing records. User codes are public identifiers stored in the Hub database for the owner's own display; they are not bearer credentials.

Both Humans explicitly choose their own published Bot principal IDs, default `[]`. Acceptance grants Human-to-Human contact and only the selected Bots on each side. It cancels other visible pending requests between the pair, including unexpired private rejections, so neither stale requests nor hidden rejection state leave a pending action or replace a newer scope. Revocation settles the same requests without changing expired or unrelated records. Scope expansion needs a new explicit bilateral acceptance. Relations return `{otherHumanPrincipalId,active,version,contactEpoch,botPrincipalIds}`. Revocation immediately denies new/reopened DMs, new DM publications and new invitations; it revokes unfinished DM AI deliveries without deleting history. It also atomically rotates both DM membership epochs, increments conversation version and emits a contact-change event, while preserving join sequence/history. Replacing an active relation through renewed consent similarly fences the old scope. Thus old outbox intents and delivery grants cannot regain authority after later re-consent; only a new explicit intent using the current membership epoch may send. Committed duplicate publications still return their original ACK. Re-consent never revives revoked deliveries. Existing shared groups retain their separate permissions and epochs. IP metadata may be shown only for confirmed authorized contacts. Legacy-to-legacy static pairs keep their prior visibility unless an explicit contact relationship supersedes it; every enrolled pair defaults to denial. Legacy multiple Humans retain distinct codes and Human relationships; Bot ownership is conservatively mapped to the instance's first stable Human because legacy records have no finer owner field.

## Admin HTTP and CLI

The original same-origin page is `/admin/`; its only script is `/admin/app.js`. It uses text nodes for untrusted names. CSP blocks external resources and framing. JSON POST routes are `/admin/api/login`, `/state`, `/decide`, `/revoke`, `/repair`, `/rename`, `/logout`. Login requires exact Origin, a scrypt-checked password and rate limits. The browser receives a 15-minute HttpOnly SameSite=Strict cookie (Secure over HTTPS) and an in-memory CSRF value; every session API requires both Origin and CSRF. No secret goes into localStorage, URLs or logs. CLI may use an explicit Authorization Bearer header instead of a cookie, with the same password check, rate limits and optional-Origin rejection. Admin identity is independent of group roles and instance credentials.

Explicit repair accepts only `{instanceId,expectedRevision}` for a revoked enrolled device. It retains the same previously proved public key, Human and user code, and atomically increments both pairing revisions and the connection epoch. It uses the same trust update as `configurePeer` inside the management CAS transaction, because calling the transaction-owning `configurePeer` inside it would nest `BEGIN`. Stale/competing repair fails `PAIRING_REVISION_CONFLICT`; it does not restore any membership or delivery. The original owner may subsequently reclaim its retained ownership using the existing explicit recovery flow. Neither repair nor join replaces a key on an existing identity or recovers a lost private key. The admin page offers Repair for eligible revoked devices.

`node communication-hub/src/admin-cli.mjs <https-origin> state|decide|revoke|repair|rename [input.json]` reads the password only from `DSBOT_HUB_ADMIN_PASSWORD`, sends no redirects, and never accepts it in argv. `--help` performs no network or credential operation. No configuration is generated by running help/design. `initializeAdmin` is an explicit provisioning helper that stores only a salted scrypt verifier; production invocation and password entry must be deliberately wired by the owner, not triggered by ordinary startup. No administrator model tool is registered.

## Public DSH storage

Use `credentialKey('ds-bot','communication-'+sha256(hubId).hex)` and `ctx.credentials.modifyRecord` with a `grant` payload `{version:1,hubId,url,publicKey,privateKey,requestId?,instanceId?,status}`. Update the record exclusively and validate its full binding on every read. Use `readRecord` in the Host at connection time, `describeRecord` for GUI status, and `deleteRecord` for explicit local removal. The callback in the current transport must become asynchronous to await this documented API. Persist nonsecret configuration with `ctx.configEditor.edit` on the unique plugin entry; never write DSH internals. Register onboarding before the existing communication-enabled early return.

The installed `@deepseek-ai/dsh-credentials` public README documents records, exclusive modification and status-only description. The local provider README explicitly states owner-only file permissions and no same-OS-user Agent isolation; it is not encrypted storage. Do not claim a keychain or same-user security boundary. Secret material stays out of model tools, prompts, queue rows, browser responses, argv and diagnostics. Local credential removal does not revoke Hub authorization; Hub revocation is independent.

## Verification boundary

`test/management.test.js` uses in-memory keys, temporary SQLite files and mocked HTTP/CLI requests. No port is opened, no real identity or credential is provisioned, and no remote device is contacted. These tests cover module behavior only. Root integration must additionally verify all base store hooks, actual browser administration, WebSocket enrollment and GUI/CLI flows. Same-machine tests are not evidence of physical cross-machine deployment.

Instance display-name overrides, version checks, synchronization and access boundaries
are specified in [hub-instance-names.md](hub-instance-names.md).
