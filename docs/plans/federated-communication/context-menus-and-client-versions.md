# Context menus and client versions (0.3.7 batch)

The owner requested a surface-by-surface review. Context menus reuse existing
operations, current permission/busy state and confirmation dialogs. A right-click
never sends a message or directly deletes a contact/member. Native text editing,
selected-text copying, file links, code and media keep their browser menus.

| Surface | Right-click actions |
| --- | --- |
| Local Bot/group sidebar | Existing pin, unread, rename, edit, duplicate and visibility actions retained |
| DSH Agent/Session sidebar | Existing agent removal and Session rename/archive retained |
| Local Bot replies, including old parts and local groups | Copy full text; quote/reply when a reply destination exists |
| Local Human messages, including old parts | Copy full text |
| Local group speaker avatar and group-settings member | Existing Bot actions menu |
| Remote message and reply-chain message | Copy, reply when writable, view replies where available, existing author-profile control |
| Remote conversation row | Open, copy conversation ID; archive a private conversation through its existing endpoint |
| Contact and its Bot row | Message if available, copy identity; contact removal through its existing confirmation dialog |
| Remote group member | Profile, copy identity; edit group identity and remove only with current management permission |
| Editors, code, file links, images, selected text, unrelated settings | Preserve native menu; do not intercept unrelated surfaces |

Menus clamp to the viewport, use the active dialog as their portal parent, support
arrow keys/Home/End/Enter, and close on Escape or outside interaction. Dialog focus
traps yield to the inner menu. Escape closes the menu before the reply-chain window.
Existing click controls remain available for touch and keyboard users.

Clients optionally send `clientVersion` in both authenticated handshake paths:
legacy paired hello and device-key proof. The Hub stores the value on the instance
and includes it in authenticated management state. It renders `Vx.x.x` in compact
rows and in device details; offline details identify it as the last reported value.
No version comparison participates in protocol or capability authorization.
An older or malformed report clears the display to unknown instead of retaining a
stale claim. This additive nullable column preserves schema-v6 compatibility.

Validation uses unit/Hub suites, Chromium desktop/mobile with real production
components (including four themes), and isolated DSH + deterministic Mock. No real
user data or model keys are used. Release numbers remain unchanged in this batch.
