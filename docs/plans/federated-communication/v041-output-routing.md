# V0.4.1 first change: explicit output disposition

Bot reply triggers do not inherit user publication from work or a parent turn.
First-level work is internal; explicit request audience remains supported. Existing
work is not reclassified. Ordinary requests entering a running user-visible local
turn queue before model consumption; urgent host insertions close the output
interval, preserving already visible text. Remote provenance remains restrictive.

Keep per-output identities (Session + turn + event sequence), ordinary text in the
local ledger, bounded metadata in state. Visibility permission is not submission;
empty text is not an explicit refusal. A final draft with no successful matching
route is shown immediately as unpublished. Sending other text elsewhere never
settles that draft. Asynchronous automatic routes remain unknown until recorded.

Recovery submits the exact stored ordinary text to an explicit local user or Bot
recipient, with one durable identity per output/target. No historical turn is
unhidden. Remote/group outputs cannot use this local recovery surface. Privacy
checks apply to Bot submissions. On an ambiguous outcome, do not resend blindly.
A recovered user report is stored before live publication; history can read it
again after reconnect. External messenger acknowledgment/outbox is out of scope.

Notices never start a turn. Prompt construction reads unresolved metadata, and
successful assistant output consumes only the notices actually offered to that
request/turn. Failed requests leave reminders available. Off/once settings affect
reminders only, never erase output evidence. Quoted excerpts never become system
instructions. Tests use mock models and isolated data.

## Implemented interfaces

- `list_turn_outputs({})`: list this Bot's unresolved local output metadata.
- `read_turn_output({outputId})`: read its own exact saved ordinary text.
- `submit_turn_output({outputId,target:"user"})`: publish a new, explicitly addressed
  local user report. With `target:"bot",botId`, submit through message_bot and its
  privacy/consultation/request-identity rules. Queued is not processed.
- `decline_turn_output({outputId})`: explicitly retain an unsent draft privately.
- Existing `publish_turn_to_user({})`: grant subsequent text visibility; it still
  returns `published:false` and is not a submission of earlier text.
- Local authenticated operator endpoints: `read-turn-output` and
  `submit-turn-output` with `{botId,outputId}`. The latter targets only the user;
  it does not expose a Human endpoint for impersonating a Bot to teammates.
- `set-prefs({undeliveredNotice:"on"|"once"|"off"})`: reminders only. The General
  settings page exposes this preference. Empty output never implies an explicit
  no-reply choice. Reminders do not inject messages or initiate turns.

Statuses are per output; ordinary text is stored in a separate outputs ledger.
Successful direct user output is `submitted-user`; automatic local reply delivery
is `delivered-auto`; a persistently held work answer is `waiting-subtask`.
`unsubmitted-text` is reserved for a completed local closing draft, excluding
reasoning, housekeeping, intermediate tool steps and remote/group execution.
`delivery-unknown` means the system cannot confirm the route's receipt, not that
nothing arrived. This includes post-Session ledger marker failure, which must not
cause an automatic second reply. Storage failures never claim confirmed recovery.

Multiple targets have separate submission identities. Sending unrelated text to a
Bot cannot settle a later draft. The output ID includes Session, turn and sequence.
A failed prompt/model request does not consume a reminder; actual ordinary output
in the turn which was offered it consumes the reminder. Resolved metadata without
recovery receipts is bounded to 300 entries; unresolved evidence and recovery
identities are retained, with full text outside state.json. No automatic retention
policy discards unresolved output. Historical turns are not reclassified.

The UI shows notices above the local composer, supports reading the saved text,
and publishing an unsubmitted draft to the user's chat. A recovered report appears
at its original turn's tail in the native UI and as a separate item in chat history.
It uses a new publication identity, not a newly unhidden historical turn. A small
screen has bounded scrolling for both the notices and original text preview.

## Gateway contract (external gateway remains separately owned)

Consume only authenticated host `/api/bot/user-output` events. The reference
`ds-bot/src/shared/user-output-policy.js` returns `{allow,reason}`:

1. Missing/unknown/internal routing is denied. Text markers such as `>>>用户<<<`
   never grant publication, including when quoted inside internal text.
2. User audience + true user origin is allowed without an explicit flag.
3. Explicit local publication requires the output's host-observed sequence to be
   inside a permitted range. Earlier already-public user output stays public after
   a mid-turn boundary closes. Private gaps remain hidden after publication resumes.
4. Recovered output has `recovered:true` and `originalOutputId`; it is a separate
   authenticated publication. Original remote provenance cannot use this route.

The gateway must deduplicate the event `outputId` and bind a Bot to an exact user
conversation. The helper is not an authentication mechanism for arbitrary inbound
JSON. Gateway delivery acknowledgment, disconnect replay and cross-channel dedup
remain outside this change. A local receipt explicitly says external delivery is
not confirmed. Neither package changes the installed DSH; the tested runtime pin
remains 0.2.1-rc.4. No Hub schema or protocol change is introduced.

## Verification

Meaningful regressions cover: inherited reply/work audience, explicit publication,
queue-before-consumption, mixed-input intervals, unrelated sends vs closing drafts,
empty/reasoning-only output, failed storage, known/unknown automatic delivery,
exact-text recovery, duplicate recovery, Bot/privacy scope, restart ambiguity,
failed-request reminder consumption, and fail-closed gateway decisions.
Verification on Linux, mock model and DSH 0.2.1-rc.4:

- Full plugin suite: 2,252 tests, 2,247 passed, 5 skipped, zero failures.
- Native team smoke: all 52 steps passed.
- Native two-instance late consultation recovery: passed, including an unpublished
  responder's long durable reply and explicit remote publication.
- Native browser + canonical stream: explicit user reports appear live; unmarked
  internal text stays hidden. Chief closing drafts show an immediate notice, can
  be read in the UI, and recover exactly once with the same receipt on replay.
  Recovered text appears in native turn tails and the chat API; zero page errors.
- Focused routing, feed, work and gateway-policy regressions passed. A further
  shutdown regression checks that queued output saves finish before releasing the
  state lock; this and the final user-receipt atomicity fix passed focused tests.
- Hub suite: 223 passed, zero failures.
- Build/generated-artifact check and lint passed (pre-existing lint warnings).

Only isolated owned test profiles were used. No production DSH, gateway, Hub data
or external messenger was changed; Windows and real WeLink delivery were not
exercised in this environment.
