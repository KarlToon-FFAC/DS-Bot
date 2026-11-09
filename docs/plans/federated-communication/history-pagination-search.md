# Progressive history and canonical message search

This V0.3.1 follow-up implements the user's items 6 and 7 without changing Hub
protocol requirements or release numbers.

The GUI initially reads 50 recent events. Scrolling up prepends one authorized
page while preserving a visible message anchor. A maximum of 200 events stays
mounted; trimming the opposite edge enables incremental reads in the other
direction. Returning to latest replaces the window with a recent page. Message
jumps load a bounded window around the exact canonical source. Late responses
from another conversation, Hub or membership epoch cannot replace the window.
Newer messages received while reading older history do not move the viewport or
mark unseen messages read. Pagination has loading/error/retry controls and an
explicit fallback button for keyboard users.

The local Human API/CLI `search-history` searches literal text in synchronized
canonical messages. Scopes are derived from current Human memberships and owned
Bot DM records, including archives, never caller-supplied principal IDs or another
Bot's group cache. Every row is constrained to its exact epoch, join boundary and
contiguous cursor. Bounded result pages include only author/time, a short excerpt
and an exact message locator. Search cannot send, read-ack, admit AI or change
membership. Cursor scope/query digests force a fresh search after authority changes.
The GUI offers all-conversation/current-conversation selection, paged results,
keyword highlights and result-to-message navigation. Empty results describe this
device's synchronized data, not every record on the Hub.

Verification uses the pinned public DSH interfaces, isolated profiles, deterministic
Mock and production React/CSS fixtures. No real user data, keys or DSH internals
are used. Final acceptance evidence follows.


## Acceptance — 2026-11-09

- Plugin regression: 2,082 tests, 2,077 passed, five skipped, zero failures.
- Hub regression: all 199 passed. Lint and generated-client checks passed with
  existing warnings only. No DSH internals, real profile or real model key used.
- Native deterministic Mock smoke: all 52 steps passed; owned bench stopped.
- Two real native DSH instances and an owned loopback Hub passed 180-message
  pagination, old-message search across result pages, bounded source jumps,
  unread preservation, Host restart and archived owned Bot DM search/epoch denial.
- Chromium with production React/CSS passed a 650-message conversation: initial
  50-event page, backward/forward scroll anchoring, a 200-event maximum window,
  live arrivals without disturbing an old window, return to latest, paged search,
  exact source jumps, cross-conversation stale-response fencing and mobile layout.
  Screenshots were inspected; zero browser errors.
- Unit boundaries cover pre-join/foreign Bot-cache exclusion, private DM ownership,
  literal Chinese/percent/underscore text, duplicate-free search pages, cursor
  scope changes, stale epochs, future events beyond a sync gap, unchanged receipts,
  ahead-of-cache Hub watermarks and stale query responses/markup escaping.
- The GUI follows `cachedWatermark`, the contiguous available cursor, instead of
  spinning against a Hub watermark whose messages are still being synchronized.
- Logs, screenshots, database fixtures and profiles remain under ignored test
  directories. Test ports were released; version remains V0.3.1.
