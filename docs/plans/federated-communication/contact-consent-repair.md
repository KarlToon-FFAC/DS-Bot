# Contact scope defaults and actionable user-code requests

The user reported two concrete failures: empty CLI/Agent localBotIds still used
an old no-Bots contract, and invalid/rotated codes produced target-null pending
rows while returning success. The third reported delegation/provenance concern
was explicitly deferred by the user and is outside this change.

## Decisions

- Omitted or empty client localBotIds follows the existing GUI published-Bot
  policy. A nonempty explicit list retains its narrower meaning and validation.
  CLI/help/Agent approval text must describe the same choice. Publication itself
  remains a separate local Human choice; no Bot is published automatically.
- Preserve historical explicit scopes, including Human-only relationships. Expose
  both sides' sharing modes in relation metadata and show empty-scope warnings
  directly on contact cards. Provide
  a versioned, locally confirmed repair that changes only the local Human's side
  to published Bots. Never silently expand the other person's consent.
- Invalid, rotated, self, unavailable or untrusted-target codes return a generic
  CONTACT_CODE_UNAVAILABLE error, without target identity or address, and create
  no request/operation receipt. Failed attempts still consume rate limits. Valid
  codes remain reusable until explicitly rotated; they are not one-time tokens.
- Existing target-null pending requests become unavailable immediately. Retrying
  their old operation IDs cannot replay a false pending success. Genuine request
  retries retain their original acknowledgment even if the code rotated later.
- A contact-consent-v2 capability fences new code-validation/repair operations
  against an older Hub. Keep private rejection masking, real request expiry,
  exact idempotency, actor checks, contact versions and DM epoch fencing.

## Operation and upgrade contract

`use-published-contact-bots {otherHumanPrincipalId,expectedVersion}` is the local
Human CLI/API operation. It dispatches `contact.use-published-bots` at the Hub;
`manage_communication_contacts` uses action `use-published-bots` under the existing
host-authenticated local-user delegation and native approval. The Hub changes
only that Human's side, increments the relation version/epoch and fences affected
DM epochs and unfinished deliveries. Old history is preserved. A stale version,
foreign actor or Bot identity cannot perform the change.

New request/repair operations require `contact-consent-v2`; defaults also retain
the existing `published-contact-scope` check. Updating only a client cannot claim
that an old Hub validates codes. Update/restart Hub and plugin together. No reset,
re-enrollment or automatic publication is required. Publishing with
`publish-bots {localBotIds:[]}` still publishes no Bots; only the contact
request/accept empty-list default changed.

## Completed verification

The exact empty-list and invalid-code regressions failed before the fixes.

- Plugin: 2,021 cases, 2,016 passed, five existing skips, zero failures. Hub:
  192 passed. Lint, generated-client consistency and staged publication scan pass.
- Hub tests cover explicit legacy scopes, own-side repair, rollback, stale versions,
  actor/epoch checks, durable failed-attempt limits, code rotation, genuine retries,
  legacy target-null rows/receipts, private rejection masking and ordinary expiry.
- Two real owned DSH instances and loopback Hub, deterministic Mock: real CLI
  empty-list request/accept, published Bot group joining and reply, legacy scope
  repair restoring DM permission, invalid rotated-code nonzero exit without a row,
  genuine retry and old target-null false-success receipt rejection. Five scenarios.
- Native original-host smoke: all 52 steps passed. Chromium at 1280x900 and
  390x844 verifies visible scope warnings, unavailable request status, standalone
  repair confirmation and preserved remote-side restriction. No page errors.

Test processes and owned benches were stopped. No production data or model key
was used. The historical Human-only scope is not silently expanded; the owner
must deliberately repair it. This work does not change delegation/result trust
or the separately deferred third report.
