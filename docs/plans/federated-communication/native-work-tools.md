# Native work tools in federated conversations

The user explicitly selected reuse of each Bot's local working directory and
existing permissions, rather than an independent remote workspace. Remote tasks
therefore gain the same native file and shell capabilities selected below. This
supersedes earlier communication-only tooling and empty-directory decisions.

The communication Session and canonical input/history remain separate from local
chats. Its persona-only preset stays unchanged: no private chat history, unrelated prompt section, MCP server,
secret tool, local team-management tool, workflow or other-chat reader is copied.
The Bot’s locally configured instructions remain subject to the remote boundaries.
The host imports only read/image-read, write, edit, glob, grep and native shell
definitions actually visible in the owning Bot's current local tool scope.
Missing or withdrawn tools stay unavailable. Calls execute with the remote
Session as owner, freshly checked membership/input provenance, the Bot's local
work directory and its permission preset. Native permission approvals remain
local Human decisions, with their source and command visible in a separate
communication dialog. Remote participants cannot answer them.

An existing Session whose immutable creation directory differs must be settled
and exported before a new segment is created in the Bot's directory. In-flight
work is never silently moved or granted a wider sandbox root. Bot permission
changes propagate to its remote Sessions; directory changes are reconciled
before subsequent execution. Background shell jobs are outside this first
change, avoiding unsourced follow-up inputs and unowned work.

The sandbox and OS permissions have their existing meaning. In particular DSH's
workspace-write mode confines writes, not all reads or network access. A shared
working directory is not a confidentiality sandbox. Prompts still prohibit
private-data disclosure, impersonation and escalation based on remote claims;
tool access and actual file effects follow the locally selected permission.

Verification uses isolated two-instance DSH profiles and deterministic Mock. It
must demonstrate real file creation/read/edit/search and shell execution in the
chosen Bot directory, permission denial/approval, tool withdrawal, preserved
identity/conversation boundaries, and a useful remote reply with no tool receipt
publication. No DSH implementation or user data is modified.

## Completed validation (2026-11-07)

- Plugin regression: 2,019 cases, 2,014 passed, five existing skips, zero failures.
  Lint, generated-client consistency and staged-tree publication scan pass.
- Native original-host smoke: all 52 steps passed; the owned bench was stopped.
- Two owned DSH instances and a real loopback Hub, deterministic Mock: native
  read/write/edit/grep/glob/Bash, one useful final, Bot-to-Bot DM delegation, Host
  restart, immutable-root segment rotation, read-only rejection and exact local
  reject/allow-once escalation. The local approval exposes source identity,
  conversation, exact command/path and working directory. Permission stays
  read-only after the one-shot approved write. No production data or keys used.
- Scope tests cover local tool withdrawal/replacement, unknown source, disallowed
  tools/background work, revoked epoch, local approval scope, cancellation and
  unchanged execution identity. Chromium desktop/mobile checks the standalone
  native approval dialog, readable command, visible footer and failure/rejection.
- This run used Linux/Bash. The PowerShell definition is reused only where it is
  actually registered locally; a native Windows run was not performed here.

Update/restart the plugin on the instance performing the work. The Hub protocol
is unchanged and needs no reset. Settled older communication-only segments rotate
into the Bot directory; unfinished legacy work remains explicitly fenced rather
than moved or replayed automatically. Background shell jobs and extra MCP/Skill
capabilities are not imported by this change.
