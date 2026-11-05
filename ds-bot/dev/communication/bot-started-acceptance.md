# Real Bot work-start acceptance

Run `node ds-bot/dev/communication/bot-started-acceptance.mjs` after the
`bot.work.started` production source is frozen. This uses fresh, statically paired
DSH A/B profiles and a real Hub on same-machine loopback ports 3187/3188,
8887/8888 and 3193. Models are deterministic local Mock instances.

The canonical event must correlate with a real DSH communication input within
the same turn's public started step, its exact
AI delivery, recipient Bot and current membership epoch. Both authorized Humans
must read the same event ID, sequence and Hub timestamp in their history. A
delivery queued while the remote DSH is stopped must have no start event. A
same-request retry must retain one DSH input, one start and one final response.
`@all` must produce exactly one start per current Bot. Unmentioned Human messages,
readOnly send rejection and a membership revoked before remote admission must
produce no start event.

The script observes public DSH session inspection through the existing isolated
probe; it does not patch DSH or synthesize agent entry. Its read-only canonical
queries inspect only its own newly created Hub database. Source-invalid,
deferred/rejected pre-step and forged/repeated receipt matrices require separate
unit evidence. This is not a cross-physical-machine or real-model test.

Add `--live-for-browser` to keep the successful fixture for at most twelve minutes
from readiness. The safe ready file contains public profile URLs, principal IDs,
the main group ID, expiry and stop-file path only. It never contains authentication
URLs, cookies, static pairing credentials or private keys. The fixture keeps
`DSBOT_WEB_OPEN=0`; Cua opens its own isolated tabs. Create the ready file's stop
file to finish early. Cleanup stops only owned processes, checks all five ports,
then deletes exact nonce profile directories. The Hub database and sanitized
acceptance evidence remain under `.dsh-test-tools`.

Recorded real validation: `bot-started-4615cf75-acceptance.json` passed all six
cases. The sanitized evidence includes actual DSH input and step sequence numbers
and their delivery IDs. GUI readiness is separate from final cleanup; after the
stop file or expiry, require `cleanedUp:true` and `temporaryProfilesDeleted:true`.
