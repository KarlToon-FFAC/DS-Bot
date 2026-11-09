# Receiving owner DM visibility and F6 follow-up (2026-11-09)

## Receiving owner of a public Bot

A Human on instance A can start a DM with a published Bot on B. The DM has two
canonical participants: A's Human and B's Bot. Previously B's owner saw neither
an ordinary Human conversation (the owner is not a member) nor a Bot private chat
(the local record filter required two Bots).

The **Bot private chats** section now includes an owned Bot's DM with a remote
Human as well as another Bot. It is a read-only owner record, with the same exact
native Bot ID, principal, conversation and membership epoch checks. B's Human is
not added to the DM and ordinary Human history reads remain denied. A DM already
including the local Human is shown only in the ordinary conversation list.
Existing pagination, references, profile reads, archives and retired identity
boundaries remain in force. The record and both message directions persist after
restarting the receiving Host. This supersedes the two-Bot-only record restriction
in `group-owner-membership-and-bot-dm-records.md`.

## F6: mentions and retired identities

Current conversation members are the source for mention validation. A current
group member remains mentionable after its contact relation is revoked; a contact
or published Bot outside that group remains invalid. Runtime already selected the
conversation roster before this change; the parser parameter named `contacts` did
not imply directory-only runtime validation.

Known retired principal IDs and unambiguous former member names now return
`BOT_RETIRED`. A fresh current identity sharing a former name wins for name lookup;
an explicit old principal remains retired. `@all` expands only current identities.
Bot display-only mentions do not become activation targets.

For an explicit unknown Human mention, the existing one-time scoped
`conversation.members` refresh can include `checkPrincipalIds`. The Hub validates
current actor membership and epoch, then reports a permanent retirement before
returning its member roster. This also diagnoses retired identities that never
joined the group, without publishing a message or consuming message sequence,
delivery, dispatch, quota or local outbox state. Unknown live outsiders stay
`UNKNOWN_MENTION`. Publication still performs authoritative validation for races.
No membership or directory authorization is widened.

A separate integration failure was found while retiring a Bot **after** contact
revocation: a newly created retirement archive appeared active despite DM contact
policy rejecting its reads, blocking initial synchronization. Hub membership
projection now includes a retired archive as active only while its DM policy
allows reads. Contact revocation keeps that archive fenced and other conversations
can synchronize. No records are deleted and no schema migration is required.

## Versions and F1–F5 status

Both package versions are **0.2.7**. The Hub header and plugin connection panel
show **V0.2.7**. Versions derive from each component's package metadata; wire values
remain bare semver and compatibility still uses protocol/capability gates. A
version difference is visible even when the versions remain compatible. Legacy
four-part implementation versions remain recognizable rather than being rewritten
as invented semver.

- **F1:** no DSH sandbox patch. Windows ACL diagnosis remains a host/deployment
  concern; this Linux verification does not certify Windows ACL behavior.
- **F2:** `remoteWorkApproval: "ask"` was added in `8c23534`; default remains
  `inherit`. Enable **Confirm every remote write or command** for owner approval.
  Native sandbox denial does not automatically become escalation.
- **F3:** `8c23534` added transport reconnect and explicit reconnect/restart result
  fields after trust replacement. Windows onsite confirmation remains distinct
  from the existing automated transport verification.
- **F4:** `8c23534` already rejects unsynchronized configuration with
  `COMMUNICATION_RELOAD_REQUIRED`. Operation-specific CLI help now also describes
  `localBotId(s)` as exact `available-bots.bots[].id` values, often `session-…`,
  distinct from global principals and remote execution Session IDs.
- **F5:** `8c23534` preserves detailed avatar errors. Valid Human and Bot public
  avatar CLI reads passed the isolated real Hub/DSH acceptance. The reported
  universal Windows failure has not been reproduced; no private local-image
  fallback is added.

## Verification

Reproducible acceptance: `ds-bot/dev/communication/dm-mentions-acceptance.mjs`.
It uses a real local Hub, two isolated DSH instances, real CLI subprocesses and
deterministic Mock, without production endpoints or keys. Browser verification:
`version-ui-acceptance.mjs` uses production components and Chromium at desktop and
390px width, including receiving owner records without a composer and the Hub
version header. Exact totals and completed acceptance cases are recorded in the
[companion evidence JSON](dm-visibility-and-mentions-evidence.json). Plugin: 2,048
tests, 2,043 passed and five skipped. Hub: 196 passed. Native DSH smoke: all
52 steps passed. Both suites have zero failures. Lint and generated-client
consistency passed; all owned test processes were stopped.

Screenshots: [receiving owner record](screenshots/human-to-bot-receiving-record-desktop.png),
[narrow record](screenshots/human-to-bot-receiving-record-mobile.png),
[Hub version](screenshots/hub-version-header-desktop.png),
[narrow Hub](screenshots/hub-version-header-mobile.png).

Deploy the updated plugin and restart the receiving DSH Host. Deploy the Hub
update for the F6 authoritative retirement preflight and revoked archive fix.
No reset or data clearing is needed; retained authorized messages can appear after
normal synchronization.
