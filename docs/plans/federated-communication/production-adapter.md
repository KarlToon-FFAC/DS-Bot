# Production communication adapter

Communication is disabled by default. It does not publish existing private chats
or memories, and does not add remote participants to the local Bot roster.

An owner enables it in a DSH patch for the existing `bot` bundle. This example
contains only public configuration and a credential **reference**:

```yaml
- id: bot
  config:
    communication:
      enabled: true
      instanceId: instance-a
      url: ws://127.0.0.1:3190/communication
      credentialEnv: DSBOT_COMMUNICATION_CREDENTIAL
      humanDisplayName: Person A
      publishedBotIds: [LOCAL_BOT_ID_FROM_THIS_INSTANCES_ROSTER]
```

The Hub must already pair this instance's stable communication instance ID.
Use `instance-b` on the second host to match the Hub example. Choose the ID
before first startup; an existing communication database retains its identity
and rejects a different configured ID. Do not change IDs to reset authorization.
For real use, the owner supplies the referenced credential through their normal
local secret mechanism. Never put it in YAML, a message, a model tool or a log.
The host consumes only the explicitly named `DSBOT_COMMUNICATION_*` process
variable and removes that variable before model tools run. It holds the value in
a host-only process lease bound to this exact profile, Hub and identity, so ordinary
configuration reactivation can reconnect after the environment value is consumed.
Disable, rebinding, rotation or authentication rejection invalidates it. A new
process needs its normal launch bootstrap again; no provider or persistent
credential is added. See [reload and join diagnostics](join-diagnostics-credential-reload.md).
Plain WS is allowed only on literal loopback. Non-loopback communication requires
WSS with normal certificate validation. No real deployment is performed here.

The repeatable local bench handles pairing entirely with transient memory values;
it needs no real model key or account. It persists the public local instance and
opaque Human/Bot identity mapping before starting the Hub. See the development
runbook rather than manually copying a startup token.

## Storage and Session boundaries

`DSH_HOME/bot/communication.sqlite` stores the instance identity, explicitly
published local identities, per-principal canonical projections, outbox/inbox,
receipt intents and Session bindings. Client schema v2 migrates v1 queues without
discarding pending operations. Hub schema v2 migrates v1 roles and speaking modes
without changing message/conversation IDs. Future versions are refused.

Each `(conversationId, recipientPrincipalId, membershipEpoch)` has an independent
binding and retained ordinary DSH Sessions. Only the intended local Bot runs;
Human display/read never prompts its Chief. Idle context pressure creates another
retained Session after previous final outputs have entered the durable outbox.
Only authorized canonical conversation history enters a fresh segment. The bench
uses a deliberately low `rotateTokens` threshold to exercise this path; the normal
threshold uses the pinned public token meter and model context information.
Communication Sessions use a dedicated publicly registered `ds-bot-communication`
Preset containing only `dsh-persona`, with optional runtime context disabled,
and their own empty workspace. The host verifies the exact active composition
and absence of leaked preset services. The assembly hook allows only the
communication persona, conversation prompt and approved communication tool
sections. Pre-step admission discards filesystem instructions and directory notices,
permits only DSH's required isolated-working-directory runtime snapshot, and
validates every request source against the local
canonical AI inbox, and rejects unknown input. A preset is not a sandbox for
arbitrary same-process plugins; custom host compositions require their own audit.
The supported acceptance profile is the pinned DSH Web profile. DSH is not patched.

Old standard-preset segments remain retained. A fully completed segment whose
final outputs are already mapped rotates into a new isolated Session before
new input. Pending, interrupted or unexported legacy work is quarantined as
`COMMUNICATION_SESSION_MIGRATION_REQUIRED`, with its events and input intact.
Changing its cwd cannot erase durable private context. It is never resumed or
copied into a new Session automatically; operator review is required to decide
whether to abandon that unfinished work or send a new explicitly scoped request.

Input intent precedes `followup`; `sessions.flush` and public `inspect` establish
the exact source identity. A cold, exclusive idle writer and repaired closed log
must prove non-admission before replay. An original restored pending input is
woken with a separately sourced truthful host restart notice. Unknown results
remain pending/diagnostic. Final text exports atomically save their durable source
event identity, message ID, complete outbox payload and cursor. Provider tool-call
IDs are namespaced by their durable assistant event because providers can reuse
call IDs across process lifetimes.
Final export requires exclusively communication/recovery requests in the same turn
and a valid exact inbox delivery. It cannot borrow a grant from an earlier turn.
A permanently rejected Bot final remains visible in the authorized Human UI and
audit queue; rescanning never regenerates it under a new message ID.

## Human and Bot ingress

The authenticated `/api/communication` route fixes the author to the local Human;
sender override fields are rejected. `send` requires a stable `messageId` and
`clientCreatedAt` so an uncertain HTTP response can be retried unchanged.
Management operations use a stable `operationId`.

Bot tools derive the identity from the actual executing local Session, not model
arguments: `list_contacts`, `list_communication_conversations`,
`send_contact_message`, `read_communication_history`, group create/invite/accept,
leave/remove, `set_communication_receiving_rule` and `end_communication_group`.
Original `message_bot` and local-group semantics remain local. Communication
Sessions use these exact-contact tools and cannot use local team-management,
private-memory, filesystem, environment, secret, execution or subagent/workflow tools.
Their tool allowlist is checked again at execution. History/list/send and group
operations are confined to that Session's conversation. Opening other contacts,
creating groups and recovering ownership remain available from the original local
Bot chat. They run through the normal DSH model/tool loop and
existing local permissions; a remote Chief gains no Main Bot authority.

Projection, target storage, Human read and AI admission are separate. Receipts
never claim the model's task or external tool side effects completed exactly once.
The local AI inbox and outbox enforce capacity; over-capacity delivery is not
acknowledged as stored. The existing queue can still drain while inbound pressure
is applied. History and transport pages preserve whole messages within byte limits.

P0–P4 local Mock gates and the subsequent governance/privacy checks passed; see
[P4 acceptance](p4-acceptance.md) and [governance evidence](group-governance-evidence.json).
Subsequent acceptance verifies local WSS with the production transport and a real
OpenAI model through independent DSH A/B hosts and the Hub. See
[encrypted real-model acceptance](openai-encrypted-reuse.md) and
[the two-machine trial](two-machine-trial.md). Different-IP operation remains
unverified; the real-model run does not prove a packaged Electron release.

## Group governance

The creator is the exact owner Participant; no Human/Chief label inherits that
authority. Owner/admin/member and Human readOnly/speak or Bot passive/active are
separate. New invitees start restricted; v1 members keep their prior speech rights.
Only the owner appoints admins, transfers ownership or ends a group. An admin
manages ordinary members and routing. Policy/transfer require the current version.
Offline owners are retained; a re-paired exact owner may reclaim a fresh epoch.
A dissolved group cannot be resurrected.

Passive Bots cannot call the send tool into a group. Automatic final export adds
`responseToDeliveryId`; the Hub validates the real stored AI delivery and atomically
consumes it once with the reply. A reply reference alone grants nothing. Passive
reply mentions do not activate other Bots. Queued publications are checked against
current permissions and receive explicit errors after downgrade. See [the role
and migration design](group-governance.md).
