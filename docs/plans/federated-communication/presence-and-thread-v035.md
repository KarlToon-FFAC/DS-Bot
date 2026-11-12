# V0.3.5: Bot presence and reply-chain entry

- Every remote Bot avatar uses one bottom-right status badge, including member
  settings, messages, mention candidates, reply chains and compact recipient lists.
  Red means currently working/replying; green means connected with a fresh host
  report; gray means offline or unknown. Tooltips and accessible labels distinguish
  those meanings. A badge on a historical message describes the Bot **now**, not
  whether that historical message was processed.
- `presence.update` / `bot-presence` is optional and does not change required
  handshake capabilities or delivery rules. The authenticated owner reports only
  working principal IDs (no task text), derived from public runtime activity and
  agent status. The Hub validates ownership/publication, binds reports to the live
  socket and expires them after 15 seconds. Disconnect, stale device epochs, trust
  revocation and retirement override old reports. Only existing authorized contact
  and member views receive presence; there is no global presence directory.
- Reports renew in normal synchronization. Actual changes invalidate projections;
  group profiles also refresh periodically even without membership changes.
  Failed optional reports do not stop durable message processing. Failed/expired
  browser or host synchronization changes badges to gray. Older clients without
  this optional reporting capability show unknown work state on a new Hub.
- `View replies` opens the chain without selecting a quoted reply or mounting a
  send composer. `Reply` selects that message and opens its composer. The same
  Reply action inside the viewer starts a deliberate reply; viewing never sends.
- Remove the visible `Bot dispatch:` prefix. Keep canonical recipient avatars and
  an accessible label; hide the entire row when the canonical recipient list is empty.
  Never infer actual recipients from text or current routing.

## Offline delivery contract

A Hub-accepted message is durable. An offline recipient with an AI delivery keeps
that delivery pending until its client stores it. Reconnecting with the same Bot
identity and active membership epoch resumes delivery/processing. If it was already
stored locally, the local journal handles recovery. Retries retain the original
message/delivery identities. Dispatch is not evidence of model start or completion;
Bots can explicitly finish without a reply. Device removal, revoked membership,
hiding/retiring a Bot or republishing a new identity does not transfer old work to
the new identity. Local queued sends are not Hub-accepted until acknowledged.

## Validation

Hub tests cover authorized presence, ownership rejection, lease expiry, socket
replacement, disconnect and revocation. Plugin tests cover work lifecycle (including
failed pre-step and live-session reload), shared badges, lost connection and distinct
thread actions. The two-real-DSH Mock acceptance tests offline AI delivery, reconnect,
single input/start/final despite retry, @all and revoked epochs, plus live contact and
group-member presence. Browser checks cover dark/mobile layouts, compact 12-Bot lists,
mention candidates, reply UI, actual badge colors and gray after connection loss.

Final V0.3.5 checks (2026-11-12): plugin 2,143 tests (2,138 passed, five
existing skips); Hub 214 passed; native Mock smoke 52/52; dual-DSH acceptance
8/8 scenarios; browser dark/mobile checks passed; lint and generated-client
freshness passed. No real model keys or user instances were used.
