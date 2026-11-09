# Pending requests, bottom navigation and independent releases

## Pending contact requests

The Contacts toolbar button has a numeric badge whenever incoming or outgoing
contact requests have `status: pending`. Accepted, rejected, cancelled, expired
and unavailable requests are excluded. Counts above 99 display `99+`; the
accessible description retains the exact count. Opening Contacts is not required
to load the count.

The badge uses authorized `contact-requests` reads, directory invalidation revisions,
a five-second fallback, and visibility/focus/online recovery. Reads are single-flight
with bounded backoff. A disconnected/failed read hides the current count. Hub and
Human scope changes invalidate late responses, so an old Hub cannot badge the new
one. Automatic reads never accept, reject, cancel or recreate an application.

## Bottom navigation

The local **Remote communication** button belongs to the fixed sidebar bottom
area above the account controls, including the collapsed rail and narrow drawer.
The remote **Back to local chats** button has its own fixed bottom area. Remote
conversation lists, invitations and connection details scroll between the toolbar
and bottom control. Long lists do not push either navigation control off screen.
The mobile conversation-header fallback remains available where the sidebar is
hidden.

## Release version is separate from compatibility

| Signal | Purpose | Effect on connection |
| --- | --- | --- |
| Package release (`V0.2.8`) | Identify GUI, fixes and deployment build | Advisory only; release inequality never blocks connection |
| Wire protocol (`dsbot-communication/1`) | Define compatible request/response framing | A genuinely unsupported protocol rejects the handshake |
| Required capabilities | Define mandatory semantics and safety invariants | Missing required capability rejects the handshake or relevant feature |
| Optional capabilities | Advertise optional features | An unavailable optional feature does not require identical releases |

GUI and layout updates change the package release, without changing protocol or
mandatory capability lists. Hub and plugin can have different package versions.
Neither semantic major/minor/patch numbers nor a comparison of two package releases
is an authorization or connection gate. Tests no longer require the two packages
to have identical version numbers.

A known older stable client release gets an update reminder while compatible
communication stays available. An actual protocol/capability rejection shows a
required update and its specific error, including whether the client or Hub lacks
the capability. Explicit handshake guidance takes priority over release ordering.
An unrelated connection refusal, timeout or TLS error does not become an assertion
that upgrading the client will solve it. Legacy implementation-date versions and
unrecognized prerelease orderings remain different/unknown, rather than guessing
which side is older.

Handshake rejection responses now add safe diagnostic metadata in
`error.details.compatibility`: Hub release, supported protocol and an update target.
This lets clients retain the reason before a successful welcome exists. Existing
clients can ignore the optional fields. Client-side checks that find a missing
Hub capability retain the Hub as the update target. The wire protocol, required
capabilities, storage schema, memberships and message queues are unchanged.

For this release, update the plugin for the badge and navigation changes. Updating
the Hub adds the richer handshake rejection details; it is not a prerequisite for
GUI changes when the installed Hub already supports the required protocol and
capabilities. Do not reset data because two displayed release versions differ.
This supersedes previous generic advice to put both components on the same release.

## Validation

`navigation-ui-acceptance.mjs` runs production React components and styles in
Chromium at 1280×900, 390×844 and a collapsed desktop rail. It verifies numeric
pending badges, acceptance/cancellation updates, fixed bottom controls with long
lists, and the explicit required-client-update reason. It uses synthetic data;
no user profile or credentials are involved. `version-ui-acceptance.mjs` also
rechecks version differences, compatible recovery and the receiving Bot DM record.

Regression tests cover late old-Hub counts, terminal statuses, and release ordering
without treating network faults as upgrade requirements. Actual Hub WebSocket
handshakes return upgrade metadata for old protocols/missing capabilities. Real
client publication succeeds with older and newer Hub release metadata when the
protocol and capabilities are unchanged.

Final suite totals, native DSH Mock smoke and two-DSH CLI acceptance are recorded in
[navigation-and-release-compatibility-evidence.json](navigation-and-release-compatibility-evidence.json).


Screenshots: [pending badge and bottom return](screenshots/remote-navigation-pending-mobile.png),
[local bottom entry](screenshots/local-navigation-bottom-desktop.png),
[required client update](screenshots/required-client-update-mobile.png).
