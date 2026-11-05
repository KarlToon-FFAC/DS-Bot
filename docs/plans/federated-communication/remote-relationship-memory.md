# Local remote-relationship memory, first phase

User-approved scope, 2026-11-05: a remote Bot needs its own identity, contact and
group knowledge, including organization, expertise, wider-project leadership and
group purpose. This phase adds **prompt guidance only**, not new authority grants,
assignment interception, permission hierarchies or a task-management system.

## Storage and provenance

`relationship_memory` is a local table in the existing communication SQLite queue
(schema 5). It is never synchronized to the Hub or automatically posted as a
message. Its namespace includes the host-selected queue scope, local instance,
Hub ID/address, executing Bot principal, and either:

- the exact conversation ID plus that Bot's membership epoch, or
- an explicitly local-user-shared profile for that Bot and Hub.

Credential-backed queues already separate Hub and enrollment public-key identity
namespaces. Re-enrollment does not inherit earlier identity memory. Legacy static
queues additionally use exact configured Hub/address and principal identities;
operators must not reuse a legacy queue for a different trust identity.

Each append-only fact has its subject's exact stable ID (self, current contact or
group), a topic, text, status, source and recording time. Message-derived records
retain canonical source message ID, actual author, conversation sequence and
epoch. A source proves who said something, not that its claim is true. Quotes and
claims about a third person remain attributed. The model may mark a fact only
`reported` or `inferred`; only authenticated local Human seeding produces
`local-confirmed`. Different reports do not overwrite each other or revoke local
confirmation. The host refuses model-supplied authority/provenance/profile fields.

There are 32 facts per exact scope, 512 characters per fact, and a 24,000-character
entry budget per prompt. Learned claims can fill at most 24 of the 32 slots,
reserving room for local corrections; confirmed entries get prompt priority.
Full scopes refuse new entries rather than evicting confirmed facts. Common secret patterns use the existing memory classifier;
this is best-effort, not comprehensive sensitive-data classification. Do not put
secrets or private information unsuitable for this audience in these records.

## Learning and use

An empty/new Bot starts with its own host identity and authorized current member
metadata, not another Bot's knowledge or local private chat history. Before each
communication prompt assembly, the host requests members **as the executing Bot
and exact epoch**. It does not borrow the local Human's or another Bot's cached
roster. Unknown or revoked authority aborts assembly; stale/unavailable prompt
metadata supplies no relationship section.

The prompt supplies bounded participant identities and group title, then this
Bot's visible records. It teaches the Bot to inspect members and only relevant,
authorized canonical history and save concise useful facts through:

- `read_communication_relationships {conversationId}`
- `remember_communication_relationship {conversationId,subjectKind,
  subjectPrincipalId?,topic,text,sourceMessageId,confidence?}`

Topics are identity, organization, expertise, collaboration-role, purpose and
collaboration-guidance. A group fact cannot become a Hub-wide profile through a
model tool. A claimed display name, Chief label or `@` is never authentication.
Every model write is checked against the current actor, membership and visible
canonical source. All model-acquired knowledge stays in its source conversation
and epoch, including DM-acquired contact facts. Learning depends on the model
using this tool; there is no hidden transcript summarizer or automatic extraction
model call in this phase.

Example: A's XX expertise, B's wider-project leader role and GroupX's development
purpose can be three distinct facts. Wider-project leader is distinct from local
Main Bot, Hub administrator and Hub group owner/admin. Locally confirmed guidance
helps the model respond to requests within the project's agreed responsibilities,
explain mismatches and ask for clarification. It does not reliably enforce who may
assign work, nor add tools or override local-user permission. Host-enforced
membership, speaking, causal budgets and conversation isolation remain unchanged.

Records about absent contacts are excluded by exact principal ID, even when a
different member has the same name. Any changed membership metadata marks old
conversation records `needsReview`; roles then need reconfirmation rather than
silently regaining current authority after a contact leaves and rejoins. The
Bot's own rejoin uses a new epoch and cannot read old-epoch records.
Reimporting the same canonical claim retains its original observation version.
Changed summaries of an old source also remain historical when canonical
membership/policy changes followed that source; incomplete source-version
evidence is explicitly marked uncertain rather than refreshed by a replay.

## Local operator initialization and correction

The authenticated loopback API/`dsbot-remote` CLI exposes three local-only
operations. They are not Hub operations or available as model seeding tools:

- `relationship-memory {localBotId,conversationId?,membershipEpoch?}`
- `save-relationship-memory {localBotId,conversationId?,membershipEpoch?,
  subjectKind,subjectPrincipalId?,topic,text,shareAcrossConversations?}`
- `forget-relationship-memory {localBotId,conversationId?,membershipEpoch?,id}`

For conversation records, supply the exact current Bot membership epoch. To seed
a self/contact profile without conversationId, explicitly set
`shareAcrossConversations:true`. This authorizes this Bot to use the fact in every
current/future conversation in this Hub where that contact is a current member,
including generated replies. Self profiles can be used in all its conversations.
Do not use this option to silently promote a group-derived fact. Group purpose or
project-specific leadership normally belongs to the group, not a global contact
profile. Group profiles are not supported. Contact-profile saves fetch the exact
selected Bot's fresh contacts, not the instance-wide directory union, and fail
closed offline. Each new Bot must be initialized independently.

Local correction means removing an exact record and, if needed, seeding its
replacement. Removal stops future storage reads but does not erase prior model
requests, DSH Session/tool history or published replies. There is no new GUI
editor in this first phase. Existing default-on own main-memory injection and its
local switch remain separate and unchanged; this feature does not make all
remote model context relationship-only.

## Verification

`test/communication-relationship-memory.test.js` covers provenance and idempotence,
conflicting claims/local confirmation, malformed and forged fields, invisible
sources/subjects, secret-like text, Bot/Hub/enrollment/conversation/epoch isolation,
explicit profile audience, same-name contacts, disconnected/revoked/stale roster
paths, fresh actor-specific assembly, restart/rollback/correction, new-Bot
bootstrap, prompt-injection-as-data and capacity budgets. CLI contracts are also
included in `test/remote-cli.test.js`. These are host/unit tests, not evidence of
real-model compliance with soft guidance. Real-model behavioral acceptance must
be run separately with synthetic facts and owner-approved credentials/budget.

`dev/communication/relationship-memory-acceptance.mjs` drives two actual isolated
DSH instances and a Hub with the local deterministic Mock. It checks model-tool
storage/recall, actual prompt group/Bot isolation, explicit local profile seeding,
same-conversation prompt refresh, restart, membership-epoch rejoin isolation and
the real isolated tool view. It uses the platform bench launcher; on Linux apply
the companion cloud-launcher work first. The ordinary native Mock smoke covers
all 52 local-team steps. See `remote-relationship-memory-evidence.json` for the
sanitized local verification summary. Neither script demonstrates real-model
judgment about who may assign work.

This extends the earlier exclusion of federated group memory only for bounded,
local, structured relationship facts. It does not enable full group memory
reviews, shared memory replication, local filesystem access, private chat
inheritance, automatic dispatch policy or business task state.
