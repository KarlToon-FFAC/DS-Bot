# Message actions and floating replies

GUI-only worktree: `chore/remote-review-ui`, based on local checkpoint `9ca5833`.
Do not publish that entire checkpoint ancestry: it contains independent pending
team-mechanism work. Integrate the approved GUI file changes separately.

Messages in the main timeline and reply chain share Copy/Reply icons with accessible
names. Groups also offer View replies. Copy uses only the displayed message text,
shows success/failure locally, and never sends a chat message. Hover and keyboard
focus reveal actions; touch media rules retain access. All remote buttons use
theme hover/pressed colors, the existing tap spring, visible keyboard focus and
disabled states. Reduced-motion removes the press animation.

Reply opens an anchored floating dialog with only the selected message subtree,
not unrelated sibling branches. Inside the floating dialog, messages appear in
canonical conversation order without repeated per-message reply quotations or
tree indentation. The underlying reply IDs and main-timeline quotations remain
unchanged. Its composer sends inside that chain, preserving
the exact reply target and leaving the main composer draft unchanged. Replies to
descendants select the corresponding target inside the window. Closing via Escape,
the close button or backdrop restores the trigger focus. Narrow windows clamp the
dialog to the visible viewport. Read-only members retain Copy/View replies but no
reply or send controls. Existing server authorization remains authoritative.

The floating composer has a separate scoped local draft and stable pending message
ID. Closing/reopening after an uncertain send retries the same intent, not a fresh
message. Explicit denials unlock editing; they do not automatically retry. Mentions,
IME-safe keyboard input and the existing bounded attachments are supported.

## Evidence (2026-11-05, 88)

- GUI/message-rendering/style tests: 55 passed, zero failed.
- Generated client build/freshness and lint: passed.
- Real Chrome on an isolated synthetic HTTP fixture: Copy succeeded; selected
  subtree and in-window send displayed correctly; main history received the
  canonical synthetic reply. This fixture uses the real React surface and style
  sheets, but a minimal Markdown substitute and synthetic request handler.
- At 390 x 844 the popup bounds were x=8..382, y=276..836, with no horizontal
  overflow. Dark read-only state showed no composer or Reply controls.
- Desktop/mobile/dark-readonly screenshots are in `screenshots/reply-popover-*.jpg`.
- Existing unrelated trial profiles/Hub were not modified. No model/API requests,
  real chat sends or credentials were used by this GUI validation.

Full plugin regression was run in the normal sandbox: 1682 passed, 2 skipped,
4 failed. Its GUI failures from the checkpoint are resolved. Remaining failures concern sandbox access to the user
home and synthetic CurrentUser DPAPI tests, plus the checkpoint's old prompt-string
assertion. They are not recorded as passing or skipped. Final cross-worktree
integration and full regression are required before publication.

## Integration boundaries

No host routing, prompts, memory, activation or authentication changes belong to
this GUI commit. Independent Hub work additionally needs its departed-device status
action exposed, and cleanup text must distinguish communication queue/cache deletion
from retained DSH journals/browser drafts. Those Hub UI follow-ups are outside this
message-actions change. Optional default-on remote local memory is a separate scope
decision: filtering recognizable secrets does not guarantee that arbitrary private
prose is suitable for a remote audience or outbound model request.
