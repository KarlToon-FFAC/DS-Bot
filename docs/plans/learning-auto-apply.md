# Automatic application of DS-Bot learning

The user's November 2026 request supersedes the manual-only decision in
`2026-10-27-agents-md-upkeep.md` for newly generated learning suggestions.

`learningAutoApply` defaults to true in the DS-Bot plugin configuration. Set it
to false to retain approval cards. Existing learning, memory and agentsMd disable
switches still take precedence. Existing pending cards are never batch-approved
on upgrade, restart or policy change. Only fresh learning reviews use this policy.

Skills remain capability-library entries attached to the learning Bot, not
arbitrary file paths. Updates require learned ownership, the creator identity and
the original hash. AGENTS.md writes remain limited to canonical project folders
outside protected DSH data. Size, secrets, exact-line anchors and edit counts are
checked again at application. Linked and non-regular files are refused. Exclusive
temporary files are atomically replaced after rechecking the writer lease,
policy, canonical path and original content. Decisions serialize per proposal;
file writes serialize per target. Skill compare-and-set runs inside capability
save after current state is loaded.

Proposals must be durably persisted first; a checkpoint write failure blocks
automatic application. A late policy change or lost writer lease is checked at
the target mutation and Skill attachment boundaries. Failed or interrupted application leaves a card
for review or dismissal rather than blind retry; logs omit suggestion contents.
A partially saved Skill retains the existing recoverable attachment retry.
Other DSH, Codex, MCP, OS and tool approvals are unaffected.

Model-generated instructions can be incorrect or malicious despite structural
and known-secret checks. AGENTS.md influences other agents using that project.
Opt out when human review is required. Repeated hashes catch normal concurrent
editing but do not lock unrelated hostile OS processes out of the final
check/rename interval. DSH and OS permissions remain in force.

Tests use temporary projects and a mock model: default Skill create/update and
attachment, AGENTS.md create/update, manual mode and switch-off, persisted cards,
invalid names, secrets, linked/protected files, concurrent changes, writer loss,
foreign ownership and duplicate decisions.
