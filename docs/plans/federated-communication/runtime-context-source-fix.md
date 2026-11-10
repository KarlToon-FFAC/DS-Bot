# Mixed runtime context can stop a newly published Bot

2026-11-10. Client fix on V0.3.1; no package version, Hub protocol, capability,
database or publication-identity change.

## Cause and correction

DSH 0.2.1-rc.4 preserves required runtime-context providers even when the isolated
communication persona disables optional context. A valid snapshot can therefore
contain the working directory and sandbox, approval, team, host and surface
sections. The old source gate recognized only snapshots containing the working
directory section alone. It rejected mixed snapshots before model admission as
`COMMUNICATION_INPUT_SOURCE_UNKNOWN`.

Recognize the SDK's named snapshot envelope independently of provider names.
Exclude the entire inherited snapshot from the canonical-input selection;
never interpret its text as a Hub task or a delivery grant. The same helper
also fixes work-start and reply/tool provenance scans. Invalid snapshot shapes
and unrecognized input sources still fail closed. Canonical delivery ID,
recipient, conversation, membership epoch, AI flag and revocation checks are
unchanged.

The public SDK refreshes required operational contexts at request admission.
Those contexts remain subject to their normal host policies; they are not
new permissions or remote provenance. Optional host context stays suppressed.
An assembly filter cannot suppress required providers because the public SDK
contract explicitly restores them. No DSH implementation is read or patched.

## Existing failed deliveries

Previously quarantined deliveries were rejected forever and could occupy the
head of a Bot's processing queue. Re-evaluate each such delivery at most once
per runtime through fresh authorization and existing journal reconciliation.
Exclusive Session writers must prove an input was not admitted before creating
it. An exact queued original is woken with recovery metadata rather than copied.
Already admitted inputs retain their existing acceptance mapping. Network
failure and a busy Session do not consume the recheck attempt. A source failure
that persists remains quarantined and does not indefinitely starve later queued
deliveries. This is not permission to replay failed model or tool execution.

## Verification

- Security regression tests cover mixed snapshots, malformed/unknown sources,
  canonical output attribution, unadmitted and queued recovery, permanent
  quarantine, transient authorization failure and busy Sessions.
- `node ds-bot/dev/communication/runtime-context-acceptance.mjs` uses two owned
  native DSH instances, a real local Hub and deterministic Mock, without keys.
  It creates and publishes a fresh Bot, invites it in passive mode, supplies
  five required operational providers alongside the working directory and
  injects an old-style pre-admission quarantine. The original mention obtains
  exactly one canonical reply and an accepted client inbox mapping. A later
  mention also works after host restart. Actual remote model requests exclude
  the optional private-context canary. Test providers and quarantine injection
  live only in the unpublished isolated probe.
- Final plugin suite: 2,092 tests, 2,087 passed, five skipped, zero failed.
  The focused security/work-start suite passes all 21 tests. Generated-client
  freshness and lint pass (existing lint warnings remain). Native Mock smoke
  passes all 52 steps. Native two-instance context acceptance passes all three
  cases, including restart, original-delivery recovery and private-context
  exclusion. All owned test processes are stopped after verification.

Deploy the updated plugin and restart the host so the old source hook is
replaced. Existing Hub data, groups and published identities can be retained;
no reset, republish or Hub upgrade is required for this client defect.
Production Windows hosts and real model services are outside this local
synthetic validation.
