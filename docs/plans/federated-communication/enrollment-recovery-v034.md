# Independent enrollment cleanup and remembered administrator login (V0.3.4)

## State and recovery rules

Pending applications show only their status and **Withdraw request**. Withdrawal
uses local, confirmed cleanup; it does not wait for cancellation or leave proof
from the Hub. Existing v1/v2/v3 signing-key records are supported without a reset.
Approved devices expose ordinary leave/forget and **Force-forget this Hub**.

Force cleanup confirms the exact Hub ID/address and observed identity fingerprint
(or request ID). It removes that Hub's configuration, key and CA trust. Retained
communication history is never attached to a replacement identity. Deleting the
communication queue/cache is a separate confirmed option; DSH session journals
and browser drafts are outside this operation. If the identity was already
removed, cleanup is idempotent and stale local configuration can still be cleared.
Without a trustworthy identity scope, cache deletion is skipped and reported.

The host reconciles saved, unpaused requests in the background even when the
onboarding dialog is closed. It performs signed **status reads**, never automatic
join resubmission. Normal polling is five seconds with failure backoff capped at
30 seconds. Connection and RPC timeouts are bounded. Existing paused/departed
identities are not resumed. The UI also refreshes live and on focus/reconnection.

| Failure | Recovery |
| --- | --- |
| Join or approval reply lost | Read the saved request status; apply a recovered approval and connect. Do not create a second request. |
| Hub deleted the application after approving it | Explicit `JOIN_NOT_FOUND`; the pending UI remains withdrawable locally. |
| Hub deleted an already-known device | `INSTANCE_NOT_FOUND` during departure-status checks marks remote absence and stops local access; local forgetting is then available. |
| Network timeout or generic authentication failure | Keep absence unknown; retry status or let the user explicitly force-clean locally. Never claim that the Hub deleted the identity. |
| Local cleanup succeeded but its reply was lost | Refresh local storage to dismiss the stale confirmation. Retrying the exact cleanup returns already-forgotten. |
| Hub application deletion succeeded but its reply was lost | Live state removes the row/dialog; retrying the exact deletion is idempotent. |
| Old cleanup reaches a replacement enrollment | Identity/request fence rejects it without deleting the new identity. |

Hub administrators can delete an application independently through a confirmation
dialog or `delete-join`. An approved application with an existing device links to
the established permanent device deletion flow, including shared-group impact
confirmation. Neither deletion requires the client's participation. Version
checks prevent an approval racing request deletion from silently deleting a newly
approved device. Missing rows and proofs return explicit domain errors rather
than dereferencing absent records. Outstanding join proofs for a deleted
application's key are invalidated.

Independent cleanup does not claim a distributed transaction: an offline client
withdrawal may leave a Hub application/device until the administrator removes it.
Likewise Hub deletion can leave local state until the client observes it or the
user withdraws. Either side can finish its own cleanup without the other side.

## Remembered administrator login

Remembered sessions are persisted in the existing Hub management database, with
only bearer-token hashes stored. CSRF nonces still require the HttpOnly cookie and
exact origin checks. There is no short idle timeout. Cookies renew on authorized
use with a 400-day lifetime, subject to browser limits and user-cleared data.
Hub/browser restart preserves login; logout, revoke-all and password changes
invalidate it. A Hub shutdown releases long polls with retryable
`MANAGEMENT_RESTARTING`, not an authentication rejection. A proved administrator
can replace the oldest remembered browser if the 64-session limit is reached.

## Verification

- Plugin: 2,141 cases, 2,136 passed, five existing skips, zero failures.
- Hub: 213 cases passed.
- Real DSH + Mock: all 52 native smoke steps passed.
- Real Hub-store fault injection: approved join with lost response, client
  restart/status recovery, administrator deletion before recovery, local cleanup
  and duplicate cleanup without join resubmission.
- Browser: old orphan pending UI, independent withdrawal with lost local reply,
  live approval transition, actual Hub/database restart with remembered login,
  a new browser context with retained cookies, lost Hub deletion reply and logout.
- Build freshness, lint and diff whitespace checks passed. Versions remain 0.3.4.
