# V0.2.9 — approved upgrade, 2026-11-09

The user explicitly requested the upgrade to **V0.2.9** after the pending changes
were completed. The plugin and Hub package/lockfile versions now both use 0.2.9.
The wire protocol and required capability lists are unchanged. Different compatible
package releases can still communicate. No reset or data migration is required.

This upgrade includes compact connection status, F4 publication reload state, safe
CLI error details and F6 current-member preflight/acceptance evidence. Future work
must again accumulate without an automatic version bump until the user requests
another upgrade.

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


## Final V0.2.9 checks

Both package manifests and lockfiles, CLI help, Hub header and generated client
now report V0.2.9. Final plugin regression: 2,059 tests, 2,054 passed, five existing
skips, zero failures. Hub regression: 199 passed. The seven real CLI/native DSH
Mock scenarios were rerun on V0.2.9 and all passed, as did desktop/mobile Chromium,
lint and generated-client freshness. The 52-step native behavior smoke passed
before the package-version-only upgrade; no Host behavior changed afterward.

See [release evidence](release-0.2.9-evidence.json). This source upgrade does not
reset data or require identical compatible package versions across a deployment.
Restart the upgraded Hub and plugin Host to load the new source. Future version
bumps remain subject to an explicit user instruction.
