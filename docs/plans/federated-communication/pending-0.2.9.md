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
