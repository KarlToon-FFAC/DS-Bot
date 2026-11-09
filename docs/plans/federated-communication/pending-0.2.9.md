# V0.2.9 pending changes — release on user instruction only

The user requested batching this change and subsequent requirements into V0.2.9.
Keep the current package and lockfile versions at **0.2.8** while work accumulates.
Do not bump versions, tag, publish or announce V0.2.9 until the user explicitly
requests that release. Source commits are development work, not a release.

## Implemented: compact connection status

A healthy connection occupies one line: the connection indicator and
`V<client> / V<hub>`. Full labels, compatible-release guidance and update advice
remain in its hover title and accessible description. An older client gets an
upward update indicator. Matching versions and compatible version differences
use the same compact layout.

Actual incompatibilities and connection failures retain detailed visible reasons
and required-update instructions. No handshake, protocol, capabilities, transport,
storage or authorization behavior changes in this UI update.

Verification: plugin 2,055 tests, 2,050 passed, five existing skips, zero failures;
lint and generated bundle freshness passed. Chromium desktop and 390px layout
checks verify a single row without horizontal overflow, hover guidance and visible
incompatible-version diagnostics, with zero browser errors. No real credentials,
production Hub or user DSH profile was used.

[Compact connection screenshot](screenshots/compact-connection-pending-0.2.9-mobile.png).

## Implemented: F4 publication receipt and F6 validation evidence

Publication saves now have `reloadReason:publication` and
`publicationStatus:saved-pending-reload`; a saved-only editor change causes
Bot-scoped calls to return `PUBLICATION_RELOAD_REQUIRED` until actually loaded.
CLI retains safe publication and mention-origin diagnostics instead of only a code.
A true current group member never shared through contacts is verified with two
native DSH instances and a real Mock reply; the user's corrected revoked/nonmember
case correctly remains `UNKNOWN_MENTION`. Hub mention preflight explicitly checks
current membership with retired-identity precedence. See
[F4/F6 follow-up](f4-f6-followup-20261109.md) for the exact evidence and boundaries.
