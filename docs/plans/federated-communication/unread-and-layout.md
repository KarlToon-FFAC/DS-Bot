# Remote unread messages and layout controls

This V0.3.0 follow-up implements the user's five interface requests without a
release-number or Hub protocol change.

- Conversation rows show numeric unread badges, capped visually at 99+ with the
  exact count in the accessible name. The local Remote communication entry also
  shows a total while the remote workspace is closed. Archived DMs keep their
  individual counts but are excluded from that total.
- Ordinary read watermarks advance only for the current latest-history page while
  the document is visible/focused, the message log is at the bottom, and no
  operation/profile/reply/member panel covers it. Browsing earlier history,
  opening a reply chain and receiving messages behind settings do not clear unread.
  Returning to the visible conversation rechecks its exact membership epoch.
- Read-only owned Bot DM records now have a durable local-owner inspection
  watermark keyed by conversation, Bot principal and membership epoch. The local
  Human API/CLI operation `bot-dm-read` requires the exact existing owned DM scope;
  future sequence numbers and stale epochs are refused. It does not add Human
  membership, publish receipts, admit AI input or send messages as the Bot.
- Reply windows grow from 520×560 to at most 880×800, bounded by the viewport.
  Independent content scrolling and the reply composer remain available on
  desktop and narrow screens.
- All seven personal-settings categories use independent, initially collapsed
  native details controls. Contents remain mounted so collapse/reopen preserves
  drafts and never submits a save. Existing version/conflict checks and explicit
  publication confirmations remain intact.
- Vertical boundaries resize the remote conversation and group information
  sidebars horizontally. Pointer cancellation/unmount restores selection/cursor;
  keyboard arrows/Home/End work through accessible separators. Bounded widths are
  remembered in local browser preferences. Narrow screens retain the drawer
  layout and hide the drag handles; wide layouts preserve room for chat.
- Group message, reply-chain and member-row avatars open the existing authorized
  participant profile. Canonical owner, public background/skills and retired
  identities use existing profile reads. Closing returns focus to the avatar;
  clicking an avatar neither sends nor changes group membership.

## Verification — 2026-11-09

- Plugin: 2,077 tests, 2,072 passed, five skipped, zero failures.
- Hub: all 199 tests passed. Lint and generated-client consistency passed;
  existing lint warnings remain.
- Native deterministic Mock smoke: all 52 steps passed; owned bench stopped.
- `unread-acceptance.mjs`: two real native DSH instances and an owned loopback Hub
  passed group/local-entry counts, exact read clearing, owned Bot DM unread across
  restart, archived-count exclusion, and durable owner inspection after restart.
- `communication-ux-acceptance.mjs`: Chromium with production React/CSS and
  synthetic authorized state passed numeric badges, seven independent folds and
  draft preservation, pointer/keyboard resizing and reload persistence, canonical
  avatar profiles/focus, and enlarged reply windows at 1280×900 and 390×844.
  Zero browser errors or unintended send/profile/group writes. Screenshots were
  inspected; logs/screenshots/profiles stay in ignored test directories.
- Unit regressions cover owner read monotonicity, stale/future rejection, unchanged
  delivery receipts, hidden-window unread preservation, profile drafts and avatar
  identity/focus. The GUI and native paths use no production data or real key.
