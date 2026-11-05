# Conversation list and contextual feedback

The user's native-group reference specifies a member-avatar stack for groups,
the peer avatar for direct messages, a short conversation title above a muted
latest-message preview, a rounded neutral selection and a blue unread dot.
Both conversation kinds use the same two-line structure. Native references are
`sidebar.js` (`BotRow` / `RoomRow`) and `mark.js` (`RoomAvatar`). Unread counts
remain available to assistive technology even when the visual marker is a dot.

## Authorized previews

`conversation.lastMessage` is null or contains `messageId`, `conversationSeq`,
one-line `summary` of at most 160 Unicode code points, `author` with exact
`principalId`, `kind` and display label, and `serverAcceptedAt`. It comes only
from the local synchronized log for the current Human's membership epoch and
history interval. Work events, other conversations, stale memberships and data
beyond the synchronized cursor do not provide a preview. Names/IP never confer
history access. Group avatar members likewise come from current authorized
member metadata, not an unrelated directory or private Session.

## Failure origins and feedback

The previous GUI rendered all unaccepted non-message outbox operations in a
permanent bottom section without filtering the selected conversation. A durable
Human rejection in one group could therefore appear as a current failure in
another group or DM. Those records were already scoped to the Human, so this
does not establish Bot impersonation or a wrongly selected author. The existing
test suites deliberately generate FORBIDDEN cases; without an operation ID,
a screenshot alone cannot identify which particular request produced its text.

Automatic Bot invitation acceptance also retried durable permanent failures on
every poll and could promote a local denial into a global transport error.
Permanent denials must remain audited, stop retrying automatically and allow
unrelated synchronization to continue. Network uncertainty retains the existing
recovery behavior. No permission check is relaxed and no rejected mutation is
silently retried under a different identity, ID or membership epoch.

Remove the bottom console/feedback section and the message-status help foldout.
Current actionable failures use dismissible contextual feedback; detailed durable
history is available only when explicitly opened and scoped to the current
conversation and actor. Pending sends retain their original IDs, drafts and safe
retry controls. Polling or opening a read-only conversation must not replay old
permission errors as new alerts. Group settings retain their local validation
and atomic-save failure feedback.

## Hub page and version diagnosis

The Hub is a separate process. Run `npm ci` then `npm start -- ./config.json`
inside `communication-hub`. Management is disabled in the supplied example.
Enable `management.enabled`, provide an administrator password of at least 16
characters via `management.adminPasswordEnv`, and configure reachable trusted TLS
for real remote devices. A new managed Hub can use `peers: []`; existing static
peers still require their configured credential environment variables.

The startup log prints the actual management address. At the default local
port it is `http://127.0.0.1:3190/admin/`; configured TLS/public origin may change
that address. New clients use the authenticated Hub's actual enabled management
URL and show its destination explicitly. A public WebSocket address alone does
not prove that a management page exists. Older Hubs or disabled management cannot
produce a falsely active link. Opening the page does not grant administrator
rights, transfer credentials or start a service.

The bottom console exists in source at `7f9b865`; its presence therefore does not
prove the user ran an old version. A working-tree SHA also does not establish
which packaged plugin or previously loaded page an external instance uses.
Upgrade the Hub and both clients to the same delivered commit, restart their
processes and reload the page when checking the new layout. This work does not
silently modify the user's installed application or existing credentials.

## Acceptance

Verify group and DM preview updates, empty histories, long names, current-member
avatar stacks and unread accessibility; owner/admin/member/read-only behavior;
permanent denial audit without cross-conversation pollution or retry loops;
uncertain sends and draft recovery; enabled/disabled Hub management links; and
actual browser screenshots. Same-machine two-instance deterministic Mock evidence
must remain distinct from physical cross-machine or real-model validation.

## Recorded results

- Final plugin regression: 1618 total, 1616 passed, two existing skips, zero fail.
  Build, generated-client freshness and lint passed.
- Hub full regression: 84/84. Permission/context and summary tests cover legitimate
  owner/admin changes, read-only speech denial, ordinary-member modification
  denial, Bot speaking modes, DM access, stale epochs and version conflicts.
- Native deterministic Mock smoke: all 52 steps passed; owned processes stopped.
- Real DSH A/B with same-machine Mock: six cases in the ignored
  `conversation-list-c2ea4a00-acceptance.json`. Group/Human-DM/Bot-DM summaries,
  unread updates, private-history isolation, permanent refusal audit and original
  queued message IDs all pass. Both fresh profiles and all five ports were cleaned.
- Actual browser: nine checks in `conversation-list-gui/browser-evidence.json`.
  The group has four member avatars, DMs have one counterparty avatar, rows have
  muted previews and accessible unread counts, and the chat has no bottom console
  or status-help foldout. A deliberate group refusal is visible only in that
  group's explicitly opened activity; a different DM has no such error. Read-only
  group input stays disabled. Old/disabled management gives guidance, not a link.
- Real Hub CLI startup, with temporary synthetic environment credentials:
  management enabled advertises its real URL and serves the login page (HTTP200);
  management disabled advertises no entry and returns HTTP404. Test processes and
  temporary databases are removed. The managed starter is included in the package
  dry-run; no production service or credential was created.

### Inline mention baseline follow-up

The user also reported lowered inline avatars and names. The label now has its
own text span, inherits font/line-height, and supplies the inline flex baseline;
the avatar centers independently. Fixed downward alignment, fixed mention font
size and fallback button minimum height were removed. Only the Markdown link's
direct decoration SVG is hidden, preserving the nested Bot avatar.

Actual text Range geometry in a real user bubble covers adjacent text, consecutive
mentions, a hard line break, a heading and strong text. All five labels match
their reference text's top and bottom exactly (0px), at actual 12/13/14px sizes;
avatar/text center differences are 0–0.5px. Code and quoted mentions stay literal.
See the private `mentions-baseline-final.jpg`, `direct-message-list.jpg` and
`readonly-no-stale-error.jpg` screenshots. This is visual verification with the
real Markdown renderer, separate from the DOM adapter tests.
