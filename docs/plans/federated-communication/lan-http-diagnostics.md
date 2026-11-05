# LAN HTTP identifiers and pairing diagnostics

## Verified causes and changes

Ordinary LAN HTTP origins do not expose `crypto.randomUUID`. Direct calls failed before requests reached the host, and the generic error hid this local failure. The shared `randomId` helper now uses native UUIDs where available and otherwise secure `getRandomValues` bytes with UUID v4 version/variant bits. All five client call sites (operations, main sends, thread sends, mention namespaces and browser bridge identity) use it. There is no `Math.random` fallback. Missing or failing secure randomness produces a fixed safe diagnostic; sends preserve text and do not issue requests. Mention rendering falls back to ordinary text without inventing structured mention identities.

The no-Hub-ID storage overview contract was already fixed in the approved Hub integration: it returns selected state plus retained enrollments, including when a Hub is configured. Explicit Hub-ID lookups still return one record. Existing tests cover configured, paused, missing identity and older credential providers. The client now also recognises an older backend's configured single-record response as the current Hub, without inferring enabled/paused state or offering an erroneous same-Hub selection.

Twenty fixed diagnostics, including the nineteen enrollment/identity codes named by the report and the new randomness failure, have English and Chinese text. Unknown codes and exception messages remain opaque; unknown or transport-uncertain outcomes still retain intent identifiers. This change does not broaden permissions or automatically retry uncertain operations.

## Verification

- Focused identifier, interface, error and Hub profile tests: 66 passed. The interface harness omits `randomUUID`, while retaining the separately required digest API for existing attachment tests.
- Full plugin suite: 1,695 passed, 3 failed, 2 skipped (1,700 total). The same protected-home avatar test and two Restricted-policy native DPAPI tests remain blocked; they are not claimed as passed.
- Build, generated-client freshness and lint passed.
- Real Chrome opened the isolated synthetic component fixture through a LAN IPv4 HTTP origin. Its visible diagnostic confirmed `isSecureContext=false`, `randomUUID=undefined`, `getRandomValues=function`. Main send, floating-thread reply and contact request each reached the fixture handler with a UUID v4. The selected Hub offered Disconnect and no Select-this-Hub button. The fixture tab and owned server were stopped afterward.
- The fixture's first contact view failed because its request-list stub returned an object rather than the API's array; the fixture was corrected and the contact flow then passed. This was not counted as a product pass before correction.

The real browser check verifies client behaviour against synthetic handlers, not a real Hub or physical-machine collaboration. Existing secure transport requirements remain unchanged. This patch does not make all browser APIs available on HTTP: attachments still depend on the secure-context digest API, and browser clipboard capabilities may also be restricted. Use HTTPS for those capabilities; do not disable browser security protections.

After installing updated host code, restart the intended DSH host process and refresh its page. A page refresh alone does not establish that the host has loaded new modules. No real instance was restarted during this verification.
