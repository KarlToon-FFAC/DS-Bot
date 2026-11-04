# Remote communication IM follow-up

Baseline: `939ca218d0ced40311fbd80a6bd20f2108d69a21`, implementation branch `chore/federated-communication`. Product labels become Remote communication / 远程通信; existing public API and tool identifiers stay compatible.

## Identity and migration

Contacts are explicitly published stable principals of paired instances, not scanned IPs. The directory groups the authenticated socket's observed IP, then separate instances and their exposed Bots/Human. Forwarded headers and claimed addresses are ignored. IP changes preserve identity, history and permissions. NAT/proxy/shared IPs do not merge identities; the observed proxy address may be displayed. New instances permit one Human. Legacy multiple-Human instances retain history and may re-register/rename existing principals, but cannot add another Human. Additive instance_addresses and principal_preferences tables preserve existing data. Owner-authenticated Human rename persists and updates member labels without altering policy versions.

## Completed operation matrix

| Requirement | GUI | CLI / Skill |
|---|---|---|
| Contacts and avatars | IP/instance headings; local deterministic avatars throughout contacts, chooser, authors, members, invitations and completion | contacts, state; exact stable IDs |
| DM/group creation | Modal selection with empty/offline guidance and explicit invitation acceptance | dm, create-group, invite, accept |
| Existing groups | Members, invitations, role/speech, receiving rule, rename, transfer, retained-owner recovery, leave and dissolve | members, remove, leave, policy, routing, configure-group, transfer, reclaim, dissolve |
| Mentions | Type @ with keyboard/IME completion; @all selects current group Bots only | send text or exact mentions; scoped Bot tools |
| Human rename | Own Human profile | rename-human |
| History/delivery | History, references, read/delivery state; actionable failures outside chat | history, reference, read, outbox, retry |
| Device onboarding | Add a device opens role-specific instructions and non-secret templates | offline setup-guide / pairing-guide |
| AI discovery | Concise core system instructions; full registered packaged Skill | dsbot-remote help and skills/dsbot-remote/SKILL.md |

The [complete Skill](../../../ds-bot/skills/dsbot-remote/SKILL.md) includes field/permission guidance and executable examples. npm installs the CLI; desktop packaging unpacks its entry and Skill. CLI authentication is explicitly supplied for the local Human over fixed loopback /api/communication, with no credential discovery or redirects. Bots use host-derived scoped tools. Remote isolated Sessions cannot use local CLI/filesystem through these instructions. Conversation visibility is a local GUI preference; CLI lists canonical authorized memberships. Avatars are local identity representations; custom uploads are not added.

## Authority and recovery

Hub mutations validate authenticated identity, role, membership epoch and applicable expected version. Unknown management outcomes retain operation IDs across panel remounts. @all never targets Humans or published outsiders; passive Bots can answer only a current authorized delivery, including explicit @member Bot delegation in that one final response; only active Bots may initiate through tools. Both modes share server-enforced causal limits. Selecting reserved-word Human names uses explicit identity tags to avoid accidental broadcast. Quoted/code text does not activate Bots.

Policy changes refresh canonical membership before another send. Missing/inconsistent authorization fails closed, and old slow responses cannot overwrite newer versions. Original raw send intent is persisted atomically with the outbox, so same-ID retry cannot retarget after rename/removal; changed payloads conflict. Legacy mention sends lacking a fingerprint require explicit reconciliation. Failed publications use non-chat feedback and explicit copy into an empty composer. Remote messages/names/references remain untrusted; Main Bot status grants no remote owner/admin rights or private-data disclosure rights.

## Add a device

Open Remote communication → Add a device, or run `node ds-bot/bin/dsbot-remote.mjs setup-guide`.

The Hub owner adds a distinct stable instance ID to the complete static peer list, privately provisions its dedicated credential through process environment, and restarts the Hub. Omission revokes an existing peer. The new device configures its matching identity/credential, trusted Hub WSS URL and explicit published Bot IDs, then starts its own profile. The local CLI session cookie is separate and never forwarded to the Hub. Verify connected/reconciled and exact expected principals at both ends before synthetic DMs and explicitly accepted groups.

Non-loopback listeners require TLS with an address-matching certificate trusted by clients. Do not disable verification. The guide does not generate credentials, alter firewalls/trust or configure other machines. Revoked peers need an explicit higher pairing revision; queue deletion or changing identity is not recovery.

## Native Bot settings

Main MEMORY.md capacity increases from 4000 to 10000 using the existing JavaScript string.length measure (UTF-16 code units). Topic capacity stays 16000, fact entry 300, topic count 40. This is per-file capacity. Shared limits feed UI/API/tool projections and persistent validation.

Main Bots can change other local Bots' workspaces through update_bot/work_dir. Roster actor checks reject non-Main cross-Bot changes; existing self-edit and Human settings remain available. Folder approval, privacy collisions and OS permissions remain authoritative. This grants no remote filesystem access. The native settings UI and authenticated local Human dsbot-team set-workspace use the same service; skills/dsbot-team/SKILL.md documents identity boundaries.

## Verification and limits

[Executable acceptance](../../../ds-bot/dev/communication/remote-im-acceptance.mjs) and [run instructions](../../../ds-bot/dev/communication/remote-im-acceptance.md) use two actual DSH hosts, a real Hub and deterministic Mock models on one Windows computer. Final run passed 8 grouped cases and 24 distinct CLI operations: exact @all recipients, passive restrictions, permission failures, rename persistence, stale versions, original-ID retries, remove-then-send race, transfer, retained ownership recovery and dissolve. Hub tests separately cover unique/legacy Humans, spoof rejection and IP changes/shared addresses.

Actual browser acceptance passed 9 cases: group creation/acceptance, completion and two Bot replies, Human send and revoked permissions, Hub outage, queued send and recovery once with the original ID. Separate native fault injection passed all 7 recovery checkpoints. Unit coverage includes UI/IME/retry, CLI authentication/failures and packaging, service authorization and native Memory/workspace boundaries. Final counts are in remote-im-verification.md.

These are same-machine Mock results, not physical cross-machine or paid-model acceptance. Actual WSS trust, routing/firewalls and operator onboarding still require deployment verification. Use synthetic content for two-machine trials. For rollback, back up Hub/profile data and return to the prior code version while retaining stable IDs and credentials; do not reset live queues to resolve uncertain sends.
