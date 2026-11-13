# V0.4.0: selective upstream message reliability backport

Date: 2026-11-13. Target: `chore/federated-communication`. Plugin and Hub stay at
V0.4.0. This is a selective backport, not a replacement with upstream main/dev.

## Sources and selection

Inspected Fei2411/DS-Bot main at
[`a66cc737`](https://github.com/Fei2411/DS-Bot/commit/a66cc737cfb6c3d8a2597e748cded6cab1206dd3)
(V0.3.6), and dev at
[`554da65c`](https://github.com/Fei2411/DS-Bot/commit/554da65c1198b11c5ed9448824e9e5999b32023c).
The merge base is `5c514ad7`. A trial merge had 34 conflicted paths, including
turns, delivery, tools, groups and feed. Replacing these files would remove
federation provenance, explicit publication, consultation receipts and tool scopes.

| Included source | Behavior and adaptation |
| --- | --- |
| `f2902f13`, `85ae6e29` | Bot-pair messages enter a separate append-only book before delivery; exchange UI reads the book. A failed merged delivery does not replace the text actually delivered. |
| `632028fa`, `ba4b66a7`, `7ff0ec8c` (ledger module at main) | Recover after a torn last line, flush queued writes on disposal, discard failed writes from memory so retries can persist them. |
| `6ffadae5`, `05d4f929` ([PR #1148](https://github.com/Fei2411/DS-Bot/pull/1148), dev only) | Keep a refused upward message as a fallback work answer when there is no ordinary answer; bound per-turn bookkeeping. Our adaptation waits for required storage and returns `LOCAL_WORK_ANSWER_NOT_SAVED` on failure. |
| `40023cc2`, `9c51734e` | Adopt running Bot/group turns after reload; mark the turn's input as already claimed, so a newly arriving request cannot steal its identity. |
| `9ee9cfbd`, `ca1fcc94` | Resolve subagents through the public service accessor; only stop actual subagent Sessions, not arbitrary forked Sessions. |
| `99b158e7` behavior | Preserve the branch's existing registration reconciliation/retry implementation. It additionally handles withdrawn tools, native/PTC assembly and unified local/remote capabilities; reload regression tests exercise it. |
| `3d6ba450` smoke changes | Read Bot exchanges through the exchange API and await asynchronous smoke assertions. |

Full upstream group-ledger/round-engine changes (`db2cbf7c`, `9538c710` and their
follow-ups) are not transplanted: they depend on upstream group/goal architecture
and would replace this branch's group and federation semantics. Upstream IM
connectors are also not imported. [Issue #1450](https://github.com/Fei2411/DS-Bot/issues/1450)
was still open at inspection: visible replies can fan out to multiple paired IM
chats. This backport must not be presented as fixing that destination-binding bug.

## Routing invariants retained

- Local consultation replies use the existing durable receipt path first. An
  unpublished local Chief remains able to reply; no Hub publication is required.
- Remote input retains `remoteSource`, `triggerOrigin: remote-bot` and
  `audience: internal` in the pair book. A caller's user audience flag cannot
  override remote provenance.
- Remote final prose still does not automatically publish to the Hub. Explicit
  communication reply/no-reply completion remains in force.
- Local user publication still requires the existing rules or explicit
  `publish_turn_to_user`. Its sequence boundary protects preceding internal prose,
  reasoning, historical internal turns and the next turn. This synchronization does
  not weaken feed/parts filters or reclassify historical output.
- A refused local upward message is a **saved fallback answer**, not a delivery
  receipt. The tool explains the intended recipient, replacement by later prose,
  waits for child work, and the existing 2,000-character fallback limit. Local
  consultation answers keep their separate full-text receipt behavior.
- Before claiming a fallback answer was saved, required storage must succeed.
  Failed storage rolls back the in-memory fallback and retry accumulator.
- Failed ledger reads and failed legacy imports stop the operation; a later append
  cannot silently create a book containing only new messages.
- Raw ledger files are protected like other shared private-Bot storage, including
  hashed names and direct shell references covered by the existing privacy guard.

## Storage and upgrade boundary

New pair history lives in `<Bot home>/ledger/*.jsonl`. Existing `state.exchanges`
are imported on first use; they are not deleted. New pair messages no longer grow
that central array. Large attachment-backed messages still rely on their files.
Readers show a message only after its delivery marker (or a legacy delivered
record), preserving the previous delivered text if a replacement fails.

The ledger is not a transactional end-to-end delivery protocol. A crash between
Session delivery and its marker can leave a delivered message absent from the
exchange UI. A successful local save or Session flush does not prove the recipient
model completed work or an external messenger displayed it. The canonical
`/api/bot/user-output` stream still lacks a durable external-consumer outbox,
replay cursor and delivery acknowledgment. A separate gateway change needs those
pieces plus an exact Bot/turn-to-user-conversation binding; inspecting raw assistant
messages or broadcasting all user-visible replies is not a safe substitute.

Back up the full isolated Bot profile before deploying. If rolling back code,
restore a matching profile snapshot or retain the new ledger for forward recovery:
old releases do not read new pair history, and reverting only package files will
make new exchanges disappear from their UI. Hub protocol, capabilities and schema
are unchanged; the Hub package version is aligned to V0.4.0 only.

## DSH dependency and validation

The runtime pin remains **DSH 0.2.1-rc.4**. This backport uses existing public APIs
and does not modify an installed DSH. Upstream's current DSH 0.2.2 line changes
assembly/tool, scheduling and other APIs; this synchronization does not certify
0.2.2 compatibility or require installing it. Upgrade that runtime separately with
a native test matrix, especially Windows sandbox/approval behavior.

Validation uses the mock model and isolated profiles, never production data or
API keys. Coverage includes pair migration/full-text reads, failed writes and
retry, refused-answer retention and failure rollback, reload identity/tool scopes,
private storage, existing consultation receipts and explicit user publication.
Results on Linux with Node and DSH 0.2.1-rc.4:

- Plugin full suite: 2,235 tests, 2,230 passed, 5 skipped, zero failures.
- Hub full suite: 223 passed, zero failures.
- Build and generated-artifact check passed; lint passed with existing warnings.
- Native mock Bot-team smoke: all 52 steps passed.
- Native two-instance consultation recovery: unpublished responder, invalid
  placeholder rejection, long durable answer, late result and explicit remote
  publication passed.
- Native browser + canonical user-output stream: two explicit local reports
  appeared without reload; intervening/unmarked internal text stayed hidden;
  no browser errors. This checks the local stream, not a real WeLink delivery.
- Regression cases include failed required answer save, failed ledger writes,
  failed legacy import and retry, provenance after re-reading the ledger,
  in-place runtime reload and an ordinary fork not being stopped as a subagent.

Owned benches were stopped. No production profile, Hub data or DSH installation
was changed. Windows and real external messenger delivery were not exercised in
this environment.
