# Hub-scoped certificate pairing and independent administration

The owner supplies a v2 Hub code over a trusted channel. It contains the exact
Hub ID/address, public CA roots, the server certificate chain, issue/expiry times
and a signature by the server certificate key. Local review validates size,
canonical encoding, dates, SAN, chain signatures and capsule signature. A real
TLS handshake still performs OpenSSL chain/usage/hostname validation before any
enrollment exchange. No certificate is harvested or trusted from a failed socket.
A substituted entire code from an attacker is not authenticated by its own roots;
the trusted distribution channel is essential and is stated in the UI.

Only this Hub ID and exact URL receive these trust roots. They are passed as the
explicit per-socket `ca`, never installed globally or in the OS, and do not depend
on startup environment variables. The existing private enrollment record retains
the public trust material alongside its existing identity. No new credential
provider or real credential is created by development/test execution.

Pairing codes expire within seven days and the signing certificate lifetime.
Saved CA trust survives code expiry, reconnect and restart; certificate validity
continues to be checked. A renewed leaf under the same CA works normally. A new
CA requires a fresh trusted v2 code and explicit confirmation for the same Hub ID
and URL; updating trust preserves the existing device key and enrollment. CA root
bundles can overlap during rotation. No silent downgrade to ambient trust.
Legacy v1 codes retain existing strict TLS behavior; a private-CA legacy Hub must
upgrade/configure a v2 code to offer environment-free pairing. Old clients reject
v2 codes rather than partially accepting trust material. Scoped credential records
use version 2, which old clients reject on rollback instead of reverting to
ambient TLS. Legacy records remain version 1. No NAT traversal added.

The Hub owner configures public pairing CA roots once on the Hub. The server's
existing TLS key signs codes; the CA private key is never needed by the Hub.
Browser administration remains independently reachable at its documented /admin/
URL. Client/DSH UI links to administration are removed. Administration uses a
standard username/password form with native password-manager autocomplete, normal
origin/rate checks and a protected short-lived session cookie. The app does not
save passwords in localStorage or extend login lifetime. A same-origin session
bootstrap permits reload during the existing session; logout and administrator
password changes revoke sessions. Tests never save passwords in the user's browser.

Browser trust for the independent admin page is distinct from client per-Hub TLS
trust. Use a browser-trusted HTTPS endpoint in real deployment; no browser warning
bypass, system trust changes, real account configuration or network exposure is
part of this implementation's local acceptance.
