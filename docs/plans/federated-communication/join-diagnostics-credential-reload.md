# Enrollment diagnostics, TLS and process-only credential reactivation

## What is known about the reported join failure

The user reported another environment outside this workstation's LAN. That
environment's deployed version, exact Hub URL, error response and administrator
request list have not been inspected here. Its join result is still unconfirmed.
No production request was repeated, no remote service was contacted, and no real
credential, registry value or certificate/private key was read.

Review Hub is local parsing of version-1 Hub code `{hubId,url}`. It neither tests
reachability nor submits enrollment. The code has no TLS certificate fingerprint;
Hub ID is not a certificate pin. The old UI hid every join error behind one generic
message and failed to reload an already saved request after an ambiguous result.
Those diagnostic/recovery defects are independently reproducible.

The UI now presents allowlisted error/phase descriptions, not exception messages,
URLs from exceptions, provider internals or secret values. It reloads local SDK
record status after failure without sending a proof or making another join.
An existing request ID is shown for administrator correlation. Prepared state
without an ID is explicitly not submitted, with no misleading approval/cancel
buttons. Pending/uncertain requests block repeat submission until status is
recovered. Explicit Hub `JOIN_NOT_FOUND` allows an explicit retry using the same
saved identity. A failed local status read keeps submission blocked.

## Exact recovery procedure

1. Preserve the current profile, communication database and saved enrollment.
   Stop clicking Join. In the new client, use Personal settings → Add a device →
   Refresh saved request. If an ID exists, use Check approval, not a new join.
2. On the intended Hub's `/admin/` page, compare that public request ID under
   Device requests. Pending needs the normal administrator fingerprint review;
   approved resumes through Check approval. Do not infer a request from a display
   name or from successful local code review.
3. Collect only the client version/commit, decoded Hub URL, request ID/status and
   safe error code/phase. Never send cookies, headers, private keys or full logs.
4. `HUB_TLS_UNTRUSTED` needs a trusted CA; `HUB_TLS_HOSTNAME_MISMATCH` needs a
   certificate covering the exact URL host/IP. Timeout/refusal needs the existing
   reachable network route/listener. Importing a CA does not fix a mismatched SAN,
   a private address without routing, or a disabled enrollment service.

## Simple CA trust without bypassing TLS

Obtain only the public CA PEM from the administrator and verify its SHA-256
certificate fingerprint through an independently trusted channel. Do not obtain
or copy the server's private key. For a source launch on Windows, after the owner
has verified the CA:

```powershell
$env:NODE_EXTRA_CA_CERTS = 'C:\PublicCertificates\hub-ca.pem'
.\start.ps1 -DataRoot '<your existing data root>'
```

For a packaged app or container, supply that variable in its actual launch
environment using its existing launcher. Fully quit/restart the Node/DSH process,
including a tray process. Node reads extra CAs at process launch; changing the
variable after launch or only refreshing a browser does not update trust.
This augments trust for TLS in that Node process, not the Windows system store
and not just one Hub; verify the CA accordingly. Hostname, expiry and peer
authentication checks remain enabled. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`,
disable `rejectUnauthorized`, skip `checkServerIdentity` or bypass browser warnings.

Official behavior: [Node CLI: NODE_EXTRA_CA_CERTS](https://nodejs.org/api/cli.html#node_extra_ca_certsfile)
and [Node TLS server identity validation](https://nodejs.org/api/tls.html#tlscheckserveridentityhostname-cert).
A future certificate-pin/code format would need independently verified trust
material and explicit host binding. Current code does not auto-trust a fingerprint
received through an untrusted code/connection, and no new trust-import UI or system
trust change is introduced in this patch.

## Legacy static credential reload root cause and fix

The legacy host consumed `DSBOT_COMMUNICATION_*` once and removed it from the
environment before tools ran. A normal config reload disposed/reinstalled the
plugin in the same process, where the environment no longer held that value.
The user-reported external temporary patch was not available as a file here;
the repository's equivalent failure was confirmed directly from its implementation.

`legacy-credential.js` retains a private process-only lease scoped to exact DSH
home/team, Hub URL, instance ID, queue path and environment-variable reference.
No cache is serialized, put on `rt`/model state, restored to the environment or
written to disk. The transport reads it only at authentication. Same-binding
config reactivation reuses it. Explicit environment rotation replaces and
zeroes the old buffer; disabled communication, a signing-record switch, binding
change, invalid replacement or authentication rejection invalidates it.
An old runtime cannot invalidate a newer rotated lease. Disposal releases active
transport references while preserving the intended same-process reload lease.
Buffer cleanup is best effort; JavaScript strings already used in a TLS/auth
operation are reclaimed by the runtime, not guaranteed cryptographically erased.

A new process cannot recover the lease: its normal launcher must supply the
bootstrap again. This adds no persistent credential or registry access. Existing
SDK signing-record enrollment continues to use its supported credential service.

## Recorded evidence

The real Config Editor reloaded DSH twice after bootstrap consumption in
`hub-onboard-4ed2cff9-credential-reload-acceptance.json` (three cases passed).
Human identity, membership version, canonical history and bidirectional messaging
survived, and a new process reconnected through normal launch injection. All owned
ports were freed and nonce profiles deleted. Earlier fixture-name/Windows import
failures were diagnosed, cleaned up and not counted as passes.

Real WSS tests use temporary synthetic certificates: an untrusted CA is rejected,
`NODE_EXTRA_CA_CERTS` at child-process launch succeeds, and a trusted CA with the
wrong SAN remains rejected. Unit tests also distinguish expiry/refusal/timeout,
without rendering raw errors. No system trust or network security was changed.

Actual browser fixture `join-tls-gui-2846619f` showed
`HUB_TLS_UNTRUSTED · ENROLLMENT_CONNECT_FAILED`, restored local prepared state with
no request ID, and no approval/cancel controls. Its real Hub had zero requests.
The screenshot is `join-reload-gui/untrusted-ca-not-submitted.jpg` under ignored
`.dsh-test-tools`. The owned tab, processes, profiles and temporary TLS material
were cleaned up. This proves the synthetic case, not the external user's cause.

Run `node ds-bot/dev/communication/credential-reload-acceptance.mjs` for repeatable
same-machine reload acceptance. It initializes only fresh owned profiles through
the existing public Config Editor fixture and does not patch DSH. Real machines,
real credentials, external deployment and real-model behavior remain untested.

Final gates: plugin 1632 passed / 2 existing skips / zero failures, including nine
new cases; Hub 88/88 existing regression; native deterministic Mock 52/52.
Client freshness and lint passed with existing warnings only. Targeted lease
invalidation tests also prove that runtime authentication rejection clears the
lease while transient network loss does not. All publication evidence remains
local/ignored; the staged tree is scanned before commit. External incident
confirmation still requires the deployed version, actual Hub URL and public
request/status/error metadata from that environment.
