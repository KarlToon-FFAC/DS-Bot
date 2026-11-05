# Pre-push review — 2026-11-03

The original P0–P4 implementation and the requested group governance and prompt
changes are implemented. The retained baseline is
`docs/federated-communication@6ede702b7d698a8d86261ecb6a2a5f1efc8e1e87`.
The implementation is on `chore/federated-communication`; main and the original
documentation branch are not rewritten. This branch is for a controlled real
environment trial, not a claim that two physical machines were tested here.

| Requirement | Implementation and evidence |
|---|---|
| P0 public DSH APIs, Human projection, Session mapping and crash reconciliation | Real local DSH probes and recovery matrices; no DSH source patches. Unknown injection remains an explicit failure state. |
| P1 authenticated Hub and durable queues | SQLite schema 2, canonical DM IDs, outbox/inbox, storage/read/AI receipts, bounded history, reconnect and explicit failures. Hub suite: 32/32 pass. |
| P2 production adapter | Exact Human/Bot principals, explicit publication, four DM directions, scoped Sessions, provenance, rotation and recovery. Native A/B integration evidence retained. |
| P3 UI and P4 acceptance | Communication pane, invitation/membership/routing controls and history; real Chrome at 508/700/1024 px in the recorded local Mock run. Native recovery 7, network 8, behavior 11, atomic 2 and original smoke 52 checks passed in the prior final review. Browser screenshots were observed in the task, not shipped as evidence files. |
| Owner/admin and speech policy | Hub checks every mutation/publication against authenticated instance, principal, membership epoch and current policy; versioned concurrent changes fail stale. Owner transfer, last-owner protection, revocation, re-entry, migration and UI controls covered in the 9-case governance acceptance and security regression. |
| Humans readOnly/speak; Bots passive/active | Separate from owner/admin role. New members restricted; v1 speakers retain compatibility. Passive automatic reply consumes an actual AI-delivery grant once; proactive group tools require active. Downgrades reject queued new publications. |
| Prompt and privacy boundaries | Local/federated context distinguished; identity and responsibility explicit; untrusted remote text does not elevate authority. Communication preset excludes private file/memory/shell and other-conversation tools; source checks run around middleware. Prompt-only security is not claimed. |
| Real official OpenAI full chain | New encrypted credential used through real DSH A/B + Hub: 7 cases pass, 6 HTTP requests (3 input counts + 3 generations), 6466 input / 22 output tokens. Conservative modeled generation cost $0.0016275; not an invoice. Restart export used no extra model request. |
| WSS | Production `CommunicationTransport` and Node WebSocket against a temporary local TLS server. Trusted private CA succeeds; untrusted certificate, wrong hostname and wrong pairing credential fail; canonical DM delivered once. No system trust changes. |

The latest plugin suite contains **1491 tests: 1489 pass, 2 original skips**.
This is separate from the original 1437-test baseline: the baseline alone is not
evidence that communication works. The dedicated Hub and real-host acceptance
matrices above verify the added paths. Lint and generated-client freshness checks
pass. Lint retains non-failing warnings. CI now includes the independent Hub job
in its required result and runs on the implementation branch; container publishing
remains limited to main/dev.

## Credentials and run boundaries

The previous provider-only pilot used 7 HTTP requests (3 generations); it is a
separate authorized run from the later 6-request full chain. Cumulative use is
13 requests across the two bounded runs, not 13 requests within an 8-request run.
No paid request was made for this pre-push review. Completed ledgers remain intact.

The first native credential window failed before a record existed because its
PowerShell module path could not load the Security cmdlets. After fixing explicit
native module loading and testing with synthetic values, a new hidden-input
window accepted a new entry. DPAPI Verify and the successful official API chain
confirmed the new record works. No failed plaintext was recovered or committed.
The approved CurrentUser-encrypted record is retained outside Git; the test
processes, windows and five test listeners were cleaned up. See
[encrypted reuse and failure details](openai-encrypted-reuse.md).

Publication reports replace local account/machine names with placeholders.
Historical source hashes describe their original local snapshots, rather than
claiming to hash later documentation changes. Raw logs, profiles, databases,
DPAPI records, key/certificate files and temporary package/test output are ignored
and excluded. The repository scan is run against an exported staged tree before
commit; its result is recorded in `pre-push-evidence.json`.

## Remaining trial scope

Different physical machines, actual network reachability, production certificates
and packaged Electron UI acceptance remain **NOT_RUN**. Local WSS is not a
different-IP trial. Real-model tests use synthetic content and three bounded
generations, not every possible model/tool trajectory. Images/attachments and
business workflow automation are intentionally outside this text transport scope.
The normal desktop provider setup does not automatically reuse the isolated test
vault. A compromised paired host is inside the Hub trust pool.

Start with [the two-machine trial and rollback guide](two-machine-trial.md).
Do not downgrade a migrated database in place, reuse another machine's identity,
disable certificate verification or reset a completed budget ledger.
