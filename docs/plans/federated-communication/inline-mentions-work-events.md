# Inline mentions and Bot work events

This follow-up follows the user's native-group examples: a small colored Bot
avatar and blue name within ordinary message text, and a separate muted line
with the Bot avatar and “{name} started on it” below the relevant message.
The parent viewed both supplied screenshots and confirmed these details. Native
references are `user-message.js` (`UserText` / `bt-umention`) and `cells.js`
(`RelayEvent`), with the existing BotMark and theme colors.

## Identity and display

Inline chips represent only the message's canonical structured mention IDs.
Names never choose a recipient. Current authorized conversation member data
supplies the avatar, display name and identity/origin tooltip. Code, links,
quoted text, unknown names and ambiguous names must not acquire another Bot's
identity. `@all` remains a structured broadcast to permitted Bots, not Humans.
Rendering must preserve Markdown and text order without raw HTML or arbitrary
external image fetches. A chip may inspect authorized member details; it must
not open a similarly named local Bot or send/activate a Bot when clicked.

## Evidence of work starting

`aiAccepted` remains admission, not work-start evidence. The optional Hub
capability `bot-work-events` allows a separate `aiStarted` delivery receipt.
Only the target host can attest its own AI delivery, under current connection,
membership epoch, stored-delivery and conversation authorization checks.

The runtime emits the durable receipt only after checking the isolated input
sources and observing the actual public Session `step/start` event for their
processing turn. A `kind: 'enter'` middleware decision alone is insufficient:
another outer hook could still refuse that decision before a step begins.
Queued, denied, unmentioned, invalid-source or unresolved inputs cannot generate
the receipt. A model's text never supplies work-state evidence. Old Hubs without
the capability retain their existing behavior without fabricated status.

The Hub publishes one canonical `bot.work.started` event per delivery, identified
by `bot-work-started:<deliveryId>`. Its fields are `deliveryId`, `messageId`,
`principalId`, `membershipEpoch`, Hub-generated `serverStartedAt`, and normal
conversation/event sequence fields. Current members receive it through authorized
history synchronization; it does not itself trigger another Bot or message.
Retries/restarts must not duplicate the event. A historical “started” line does
not claim the Bot is still running or has completed work.

## Acceptance

Unit and DOM cases must cover exact/ambiguous/unknown identities, Markdown
literals, native avatars, real event deduplication and absent false start rows.
Service tests must cover current Bot ownership, Human/non-AI denial, revoked and
stale membership, storage ordering, retry and old-Hub compatibility. Same-machine
real DSH A/B with deterministic Mock must associate a work event with the actual
input delivery and source message, and synchronize the same event to both views.
Actual browser inspection and screenshots check inline layout and muted event
appearance. Physical cross-machine and real models remain outside this round.

## Recorded verification

- Plugin full regression: 1604 total, 1602 passed, two existing skips, zero fail.
  Communication frontend cases: 41/41; backend communication subset: 53/53.
- Hub full suite: 83/83, including three new work-event authorization,
  idempotency, rollback and persistence cases.
- Native Mock smoke: all 52 steps passed; owned host and Mock stopped.
- Fresh real DSH A/B plus deterministic Mock: `bot-started-4615cf75-acceptance.json`,
  six cases passed. Offline queue and unmentioned/read-only/revoked paths have no
  false starts; real step/input proof, both views, same-ID retry, reconnect and
  `@all` target deduplication pass.
- Actual browser: `inline-mentions-gui/browser-evidence.json`, eight checks and
  screenshots including `markdown-inline-start-fixed.jpg` and `remote-view.jpg`.
  Inline avatars/names, bold/list/code/quote preservation, read-only mouse/keyboard
  inspection, accessible start labels and identical event IDs in both views pass.
- The browser found a nested Markdown root inheriting dark-theme ink inside a
  light user bubble. The container inheritance was corrected and all tested
  paragraph/list text now uses the bubble's readable ink. Final full regression
  and generated-client freshness check passed after this correction.

The first real run found that this DSH records `step/start` **before** the
associated `user/message`. The implementation and evidence now correlate inputs
inside the actual step/turn window; they do not require a guessed log order or
infer work from admission. That initial run remains a failed diagnostic, not a
pass. The public Markdown renderer's existing HTTP(S) image behavior is unchanged;
these tests fetched no external image. Screenshots/logs/profiles are private test
artifacts and are not publication inputs.
