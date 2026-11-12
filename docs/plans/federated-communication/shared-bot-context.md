# One Bot across local and remote conversations (0.3.7)

The owner explicitly enables the same Bot to collaborate locally from a remote
turn, read its own local and remote history, and maintain its own long-term memory,
Skills and workspace instructions. Separate Sessions remain execution contexts,
not separate identities. Publication is not required for a local teammate.

- Local consultations use durable request identities and the existing local work
  graph. Responses settle an internal result addressed to the requesting Bot and
  originating remote binding. Polling an existing request never resends it.
- A local result is returned as tool data, never automatically published to Hub or
  mirrored to the Human. The caller explicitly replies or declines remotely.
- Remote memory tools reuse local remember/recall/forget, constrained to the owning
  Bot. Source metadata identifies the canonical remote input; remote claims cannot
  become local-user authorization through memory.
- Own-chat search uses the existing local index. Remote history uses only that
  Bot's authorized local projections, with the same membership/epoch checks as
  normal history. Other Bots' private chats are not included.
- Skills use the existing capability save and attachment permission checks. Files
  such as AGENTS.md use the already-enabled native work tools and existing sandbox.
  Workspace instruction loading uses the SDK's public instruction loader. Changes
  are re-read for subsequent remote requests; no DSH installation is patched.
- These changes do not automatically forward internal histories, memory, reasoning
  or closing prose, and do not change the release version until requested.
