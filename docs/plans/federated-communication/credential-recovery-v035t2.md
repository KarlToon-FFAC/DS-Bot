# V0.3.5T2: enrollment credential recovery and DM avatars

## Approved Hub, stuck client

`CommunicationOnboarding.result()` added `remoteMissing: undefined` to every
saved enrollment result. The DSH local credential provider requires grant payloads
to survive a JSON round trip and rejects this field with a TypeError. The client
reported `COMMUNICATION_CREDENTIAL_WRITE_FAILED`, even though the Hub had already
approved the device. This was a plugin serialization defect, not evidence of a
broken credential provider or a missing Hub response. In-memory test records
previously accepted `undefined`, masking the incompatibility.

Delete the obsolete marker instead of assigning undefined. The withdrawal cleanup
also omits an absent withdrawal ID. All onboarding fixture mutations now enforce
the real JSON round-trip contract, and a regression uses the actual public DSH
file credential provider in an isolated temporary directory.

The private signing identity and request ID were already durably saved before the
join proof. After upgrading/reloading the client, existing status reconciliation
can recover the original approved instance and configure communication. It neither
resubmits a join nor creates a replacement key. No database reset, deleting the
application, or approving another device is necessary for this failure.

`dev/communication/enrollment-credential-acceptance.mjs` combines a real WSS Hub,
a generated test CA and the actual DSH file credential provider. It reproduces the
old invalid write after automatic approval, then verifies that the fixed client
recovers the same request/identity, keeps one Hub device, authenticates, and also
completes a fresh automatic admission. It never uses user data or model keys.

## DM counterpart avatars

Avatar rendering now resolves current authorized directory metadata rather than
retaining a stale member snapshot. Image replacement and removal update the list,
chat title and message authors without a page reload. Bot-to-Bot conversation
avatars use `viewerPrincipalId` to exclude the local Bot even when the title/search
caller passes the Human owner. Group selection, revoked-avatar access and cache
scope remain governed by their existing rules.

## Version and validation

The GUI and remote CLI show `V0.3.5T2`; npm manifests use the valid semantic version
`0.3.5-T2`. Release ordering recognizes the T suffix; protocol/capability admission
is unchanged. Plugin tests: 2,146 total, 2,141 passed and five existing skips. Hub:
214 passed. Real-provider/WSS recovery and three browser DM scenarios (Human,
Bot, Bot-to-Bot; replacement/removal without reload) passed. Lint and generated
client freshness passed.
Native DSH + Mock smoke: all 52 steps passed; isolated test processes stopped.
