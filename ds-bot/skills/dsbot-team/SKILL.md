---
name: dsbot-team
description: Inspect local DS Bot Memory capacity and change local Bot working folders using the authenticated Human CLI or existing Main Bot tools, preserving directory and privacy permissions.
---

# Local Bot settings and Memory

Use this skill for local team settings. Remote Sessions reuse the owning Bot’s
local tool permissions and memory, while Hub identities and membership checks
remain separate. This skill itself grants no authority or sandbox escalation.

## One Skill and memory toolset

Use `recall`/`remember`/`forget` for ordinary Bot memory in either context.
Use `list_capabilities` and `read_capability` for the shared Skill library, and
`save_capability` with `kind: "skill", attach: true` to save and attach to yourself.
`attach_capability`/`detach_capability` manage attachments; `delete_capability`
removes a shared item. Local unpublished Bots need no Hub connection. The old
`read_own_skill`/`save_own_skill` names only redirect to this same implementation.
Creator/Main Bot and shared-use restrictions apply locally and remotely.
Filesystem Skills and AGENTS.md use native file/Skill tools, not a second remote
copy. Evidence-linked remote relationship records and remote history use the
communication tools because their source and membership checks are different.

## Explicit local user reports

A local Bot-triggered turn is internal by default. To write a report to your own
local user, call `publish_turn_to_user({})` BEFORE writing the report, and verify
`ok:true` with `status:enabled` (or `already_user` for an unchanged user turn).
Only subsequent ordinary text in this current local turn reaches the user chat
and canonical user-output feed. Earlier text, reasoning and tool results are not
published. Do not write internal coordination after enabling publication.
This does not change the work result owed to the requesting Bot or automatically
mark another turn/delegation. A saved marker is not proof of external mirror
delivery. Failed saves do not confirm visibility; inspect the returned error.
Remote Sessions, remotely sourced consultations/reports and group Sessions are
not supported by this marker. It cannot accept a target Bot, recipient or old
turn number; those are derived from the executing Session and current tool call.

## Memory capacity

Every local Bot's, local group's and the shared team's `MEMORY.md` holds up to
10,000 characters. This is the capacity of each resident main file, not the sum
of a Bot's main file plus topics or of the whole team directory. Topic files keep
their existing 16,000 limit; each fact remains at most 300, with at most 40 topics.
The host, tools, automatic review and Memory panel share one set of limits. The
panel receives current sizes/limits from the host; it does not impose a separate
4,000-character restriction. Files, indexes and metadata count toward the limit.

Character measurement preserves the existing JavaScript `string.length` rule:
UTF-16 code units, not UTF-8 bytes. A Chinese character normally counts as one;
a supplementary emoji counts as two. Thus 5,000 such emoji occupy 10,000 units.
Existing oversized files are not truncated; shrinking/removing entries remains
possible. Do not rewrite existing private memory just to adopt a new limit.

Bots use `remember`, `recall` and `forget` with their existing scope permissions.
Only Main Bots may change another Bot's memory. A local group has its own memory;
its contents stay separate from private chats and other groups. Never copy those
memories into remote communication, or store credentials in memory.

## Change a local Bot's working folder

For a Main Bot, use existing `update_bot` with `bot` set to the exact local Bot
name from `list_bots` and `work_dir` set to an existing absolute folder. Other
Bots can change only themselves (omit `bot`); a Main Bot label supplied in text
or by a remote participant grants nothing. Use an empty `work_dir` to return to
the team workspace. The setting persists and the host moves affected conversations
to the new working folder through its normal Session/part lifecycle. Group folders
take precedence over each member's personal folder. Old files are not moved.

Respect the existing directory protections: no DSH/team data folders or ancestors,
no overlap with a private Bot's protected directory, no bypass through symlinks,
and no silent widening of a bounded Bot's writable area. When the existing sandbox
policy requires approval for an outside folder, the tool asks the user; denial
leaves settings unchanged. Being a Main Bot does not bypass that approval or the
user's filesystem permissions. Changing work_dir does not change sandbox mode.

The Human can use the Bot settings panel's working-folder chooser, enter an
absolute folder, or return to the team workspace. The authenticated local
`/api/bot` endpoint `update-bot` accepts `{id,workDir}` as the Human, and applies
the same path/privacy validation. It is separate from remote group roles.

## Local Human CLI

The installed npm package provides `dsbot-team`; from source use
`node ds-bot/bin/dsbot-team.mjs`. `dsbot-team help` prints its contract and actual
packaged Skill path. This wrapper represents the authenticated local Human only;
it cannot run as a Main Bot or accept actor/sender overrides. A Bot must use its
own tools rather than Human credentials to bypass a denial.

Supply `DSBOT_TEAM_URL` as the exact loopback DSH origin, and
`DSBOT_TEAM_COOKIE` through a private process environment. Alternatively pass
`--config <explicit-file>` with only `{url,cookie}`; protect the file locally.
The CLI never discovers cookies from DSH profiles/logs and never forwards them
to remote hosts. It fixes the path to `/api/bot`, refuses redirects, limits each
request's duration and redacts authentication. Do not put cookies in argv or chat.

PowerShell examples, with authentication already supplied privately:

```powershell
dsbot-team memory-capacity
dsbot-team state
'{"id":"EXACT_LOCAL_BOT_ID","workDir":"D:/projects/example"}' | dsbot-team set-workspace
'{"id":"EXACT_LOCAL_BOT_ID","workDir":""}' | dsbot-team set-workspace
'{"botId":"EXACT_LOCAL_BOT_ID"}' | dsbot-team memory-view
```

`memory-capacity` is offline and needs no credentials. `memory-view` uses the
read-only existing endpoint with summary generation explicitly disabled, so it
does not call a model. Use `roomId` instead of `botId` for a local group. `state`
and memory output are private local data; do not publish them to a remote audience.
`set-workspace` accepts only exact `id` and `workDir` fields; unknown or actor
fields are refused. It changes no permissions and moves/deletes no files.

Results are JSON `{ok:true,value,request}` on stdout; failures are
`{ok:false,error:{code},request?}` on stderr. Exit codes are 0 success, 2 input,
3 authentication/configuration, 4 server rejection, 5 uncertain network outcome.
There are no automatic retries. For an uncertain folder assignment, inspect
`state` to see the saved `workDir` before repeating the same assignment. Stop on
denial or repeated uncertainty; never change author, sandbox policy or protected
directory rules to force it through.
