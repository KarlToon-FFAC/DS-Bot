# Local IP notes

IP notes are private address labels in Remote communication > Manage contacts.
Users can add a literal IP, edit its note, clear it, or cancel without saving.
The directory offers one row per normalized IP. Saved labels remain editable when
a device disappears or changes address. Contact search also finds notes. Contact
cards and new-message/group participant pickers display the note beside the IP
without replacing the address, device identity or principal identity.

## Storage and boundaries

- Notes use the existing local communication SQLite database in a separate
  `local_address_notes` table. The additive migration does not rewrite queued
  messages, identities, bindings or relationship memory.
- Enrolled Hubs retain their existing separate database paths. Labels are local
  to that database, not synchronized to another device or Hub. They have the same
  local filesystem protection as chat history, not credential-vault encryption.
- Only the authenticated local UI state response carries the note map. The
  `set-address-note` UI endpoint writes locally and checks the exact Hub/instance/
  queue scope and read-only lock. It never calls Hub RPC, creates an outbox item,
  adds a tool, appends a message or seeds a Bot's memory or prompt.
- Notes render as plain text. They cannot change recipients, membership, trust,
  ownership, avatars or roles. Devices behind one NAT retain separate stable
  principals and share only the IP label. If a device changes IP, the old note
  stays attached to its old address, never to the person.

## Input rules

- Literal IPv4 and IPv6 only. No DNS, URL, shorthand or octal IPv4.
- Valid IPv4 ports and bracketed IPv6 ports (1–65535) are omitted from the key.
  Bare IPv6 is parsed whole; its last segment is never guessed to be a port.
- IPv6 is lowercased/compressed. IPv4-mapped IPv6 shares the IPv4 key. IPv6 zone
  identifiers are rejected because an interface scope cannot be inferred safely.
- Notes allow at most 160 UTF-16 code units. Surrounding whitespace is trimmed;
  empty content clears a note. Line breaks, control and bidi override/isolate
  characters are rejected. The database allows 256 addresses; editing and
  clearing remain available at the limit.
- Validation errors have safe translated codes. Failed UI requests retain the
  draft. Pending submissions are locked against repeated clicks. Cancel and
  successful saves return keyboard focus to the editor's opener.

## Verification

`ds-bot/test/communication-address-notes.test.js` and IP-note cases in
`ds-bot/test/communication-directory-ui.test.js` cover normalization, durability,
rollback, limits, Hub isolation, stale scope/read-only rejection, no publication,
shared-NAT identity separation, text rendering, search, cancel, retry and clear.

Verified on the final source in the isolated cloud worktree:

- Full plugin suite: 1,770 tests, 1,766 pass, four existing skips, zero failures.
- Client build and generated-file check, lint and whitespace check pass. Existing
  unrelated lint warnings remain.
- Real DSH/local Mock smoke: all 52 steps pass.
- `node ds-bot/dev/communication/ip-notes-acceptance.mjs`: all three cases pass
  with two isolated real DSH hosts and a loopback Hub. Saving does not change the
  peer note map, contact identities or outbox. The Hub and actual Mock inputs do
  not contain the private canary. Invalid IP/stale-scope writes fail safely.
  Notes survive host restarts; mapped-address edits reuse the key and clearing
  remains cleared after another restart. All owned test processes are stopped.
- Official internal static preview of production UI components: desktop and
  390px phone dark layout, save/edit/clear, reload retention, IPv6/port format,
  restored keyboard focus and new-message IP heading are checked. Phone content
  width equals its 390px viewport. The preview and its browser tab are closed.
  This synthetic browser check does not claim live network delivery; the two-host
  acceptance above establishes the actual local API/storage behavior.
