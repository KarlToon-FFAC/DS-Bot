# Reply chains and personal settings

The previous commit `edd25e46a9943e89f88c5bae451d766e71a6d607` passed
all 15 jobs of CI run 41787765057 before this follow-up began.

## Behavior and boundaries

Each canonical group message has a View replies action. Its independent dialog
shows the earliest authorized ancestor, all nested descendants and sibling
branches in canonical order. Indentation, parent excerpts and a selected-message
accent distinguish branches. It reuses the existing message, avatar and mention
components rather than copying another product. The native message toolbar and
quote interaction in `cells.js` were the interaction reference.

Reply in this dialog returns to the existing composer with the exact source
message. Existing inline quotes, source jumps and normal sends remain intact.
The chain is derived from `replyToMessageId`, not the Bot causal budget root:
reading a chain cannot activate a Bot, send, reset a loop limit or mark other
main-history pages read. Independent topics stay separate even in the same group.

The host's `thread` endpoint, CLI command and `read_communication_thread` Bot tool
derive the actor normally. Every recursive edge is scoped to conversation,
principal, active membership epoch, join boundary and contiguous local cursor.
The same scope applies to both ancestors and descendants. Missing earlier
context is explicitly unavailable; other principals' caches are never searched.
Recursive UNION terminates malformed cycles. Pages contain at most 100 messages;
continue with `after:nextAfter` and the returned fixed `watermark`. Reopen for
new replies. Bot tools retain the existing remote-session conversation boundary.
No schema migration or Hub protocol change is required.

Read-only members may view chains and member information, but the whole composer,
send button and message Reply actions are absent. Revoked/unjoined members have
neither history nor a composer. Authorized DMs and speaking members retain normal
send behavior. Existing server permission enforcement remains authoritative.

There is no message-status foldout or bottom console. The unused status-help
translation was removed as well. Required action failures remain short,
dismissible notifications outside chat; detailed durable audits are available
only through the explicit Activity details dialog.

One gear at the sidebar's upper right owns personal settings: local closed-list
visibility, own name/avatar/reset, device identity, Hub enrollment/manual setup,
Hub management link and contacts. The contact manager also owns user-code
rotation, contact requests/decisions/revocation and Bot publication scopes.
Group-specific member/title/receiving rules stay in the group panel. Refresh,
new chat and new group are actions rather than personal configuration. Chinese
interface copy uses 本人/用户/人; stable Human IDs, API/CLI names and stored display
names are preserved. Closing an unsaved profile discards its draft as before.

## Acceptance matrix

| Request | Implementation | Positive and negative evidence |
| --- | --- | --- |
| Independent multi-level reply chains | queue-store/runtime thread, communication-thread, GUI/CLI/tool/Skill | Ancestors, nested replies, siblings, pagination and unrelated topic exclusion; cross-conversation, Bot-private, old-epoch, pre-join, cursor-gap and revoked access denied; cycles terminate |
| Remove status foldout | communication footer and i18n | Actual browser has zero status-help/feedback elements; ordinary errors remain outside chat and audits stay scoped |
| Hide unauthorized send controls | communication canSpeak guard and thread controls | ReadOnly browser has zero footer/textarea/send/Reply controls; real writable Human DM retains composer; existing permission rejection tests remain intact |
| Personal settings gear and natural Chinese | communication settings dialog, styles, i18n | Real upper-right alignment, all configuration categories present, unsaved profile reopen restores old value, closed-list checkbox restores hidden row |

Unit/regression evidence is under ignored `.dsh-test-tools`:
`reply-chain-final-tests.log`, `reply-chain-final-lint.log`,
`reply-chain-hub-tests.log`, and `reply-chain-native-smoke.json/.log`.
The focused UI/queue/CLI run passed 55 tests before final regression.

Same-machine actual DSH A/B + real loopback Hub + deterministic local Mock passed
7 cases in `reply-chain-9206abe2-acceptance.json`. Its owned processes were stopped,
all five ports checked free, and both nonce profiles deleted. No real model,
real device, persistent credential, user DSH profile or VirtualInput process was
used. CLI fixtures remain non-secret synthetic data.

Actual browser evidence: `reply-chain-gui/browser-evidence.json` records 8 checks.
Screenshots `thread-readonly.jpg`, `readonly-no-composer.jpg` and
`personal-settings.jpg` show the final UI. A real GUI synthetic deep reply reached
B as the fifth message of the same chain, while the separate topic was absent.
The browser also verified profile rollback, closed-list visibility and writable
DM controls. Both owned tabs were closed. Physical cross-machine/WSS deployment
and real-model behavior were not exercised by this follow-up.

Run `node ds-bot/dev/communication/reply-chain-acceptance.mjs` from the repository
root. Add `--live-for-browser` only for a bounded 12-minute visual inspection;
the sanitized ready file provides a stop-file path for early owned cleanup.
Require final `cleanedUp:true` and `temporaryProfilesDeleted:true`.

Final local gates: 1623 plugin tests passed, 2 existing skips, zero failures;
generated client freshness and lint passed (existing warnings only). Hub regression
passed 84/84, and native deterministic Mock smoke passed all 52 steps with owned
process/profile cleanup confirmed. The 7 added plugin cases are four queue/thread
boundary tests and three GUI tests; the broader counts include existing regression.
The staged publication tree scan passed with zero must-fix secret/privacy findings.
Screenshots, logs, databases, process files and temporary profiles are not committed.
