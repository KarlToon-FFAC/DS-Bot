# Remote attachments

The local UI supports pasted/dropped/picked images and generic file cards through
DSH's public AttachmentStore. Remote messages will preserve these interactions,
but use a bounded inline attachment array in the existing authenticated envelope.
The first version admits at most four files and 64 KiB total binary bytes per
message. Larger files are explicitly rejected. This is intentionally below the
existing 128 KiB wire envelope; text plus files must still fit that envelope.

Each descriptor carries a plain basename, MIME type, byte count, SHA-256 and
canonical base64. Both the sender queue and Hub validate all bytes before atomic
publication. There is no URL fetching, arbitrary local path, public download
endpoint, new credential or separate unauthenticated blob store. Existing
membership epochs, join sequence, read authorization, removal, idempotency,
offline queue and crash recovery apply to the entire message and its files.

Only safe raster MIME types can render as images. Other files download as inert
octet streams on explicit user action; HTML/SVG never render inline. Received
content is untrusted data, never instructions or executable code. A new optional
wire capability prevents attachment publication into an incompatible recipient
instance; old Hubs continue to support text but cannot accept attachments.

Attachment contents are private to the intended conversation but are retained in
the Hub and authorized local queues/history. Revocation prevents future reads;
it cannot erase already downloaded copies. No production database is migrated
for isolated acceptance. Large-file chunk transport and resumable external blob
storage are outside this initial bounded format.

## Comparison with the original local chat

The pinned public `@deepseek-ai/dsh-attachment-local` README and implementation
declare defaults of **20 MiB per source image, 20 images per message, 200 MiB
aggregate source image bytes, 64 million pixels and 8192 pixels per side**.
Images are normalized to a default 2048×2048 pixel budget and approximately
4 MiB encoded-byte target. Its generic file storage preserves bytes without
admission limits of its own; effective upload/transport/deployment limits belong
to the caller. This does not mean arbitrary-size uploads are safe or supported
by every local entry point.

The remote 64 KiB limit is an implementation boundary, **not full local parity**.
Base64 expands bytes by about one third and the existing WebSocket envelope is
128 KiB. Inline bytes also multiply history/sync responses and durable queue
storage. Keeping four small files under 64 KiB made the first atomic, authorized,
offline/retry-safe format fit those existing bounds. It excludes many ordinary
screenshots and documents and should not be described as finished local-chat
attachment parity or a general-purpose file-transfer solution.

Recommended next implementation: retain small control/message envelopes and add
authenticated, resumable bounded upload/download chunks. Persist immutable
content-addressed blobs separately per Hub, link them only after size/hash
verification, enforce quotas/unfinished-upload expiry/rate limits and current
membership/epoch/join-sequence checks on every read, and preserve stable retry
IDs through crash recovery. Negotiate this as a separate capability; old peers
must reject large attachments explicitly. Expose matching GUI and CLI operations,
use the public DSH AttachmentStore for model input, and test revocation, concurrent
uploads, offline/resume and hash failures. Target the local image defaults with
explicit configurable file quotas; do not merely increase the wire envelope or
replace authenticated blobs with public URLs.
