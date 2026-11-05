# Contact directory and management exits

The Remote communication toolbar now has a dedicated Contacts button. It opens
the contact directory directly instead of requiring Personal settings first.
The existing settings entry remains available.

## Directory behavior

- Human cards group authorized Bots by stable device identity. A shared IP or a
  duplicate display name never merges identities. Legacy multi-Human devices use
  the Hub's binary-ordered first-Human ownership convention. Bots without a
  visible owner remain in a separate available-Bots section.
- Cards show Human/Bot type, local/remote origin, device label and observed IP.
  Exact Human/device/Bot identities remain in a Contact details disclosure.
  The directory does not infer an online state from a visible identity.
- The other person's authorized Bots and the local Bots shared with that person
  are separate. `contact-relations.botPrincipalIds` is the local sharing scope,
  not the other person's Bot list. An active relation missing from the directory
  remains visible with unavailable details, without an avatar request or DM
  action for the missing identity.
- Search matches names, Bot names, device labels, IDs and observed addresses.
  Message always submits the exact principal ID. Duplicate clicks are disabled
  while opening a conversation. Closing or navigating away prevents the late
  result from selecting a conversation. Hiding the whole communication workspace
  or switching out of Bot mode invalidates that navigation even if reopened
  before the response arrives.
- Add a contact, Contact requests and Published Bots are separate, initially
  collapsed disclosures. Pending requests have an accessible count. Publishing
  and contact acceptance retain explicit selection and the existing versioned
  operations. No Bot is selected for a new request by default.
- A contact-version conflict refreshes requests and relations to show the latest
  terminal state. It never automatically retries acceptance, cancellation or
  removal.

## Exits and accessibility

Every client dialog has a visible Close control in its sticky header. Settings
subpages additionally have Back, which returns to Personal settings and focuses
the exact launching control. Close/Escape restore the original toolbar trigger.
The existing reply popover keeps its dedicated close action. Exit controls remain
usable while work is pending. Search/group initial focus, the existing keyboard
focus trap and backdrop dismissal remain supported.

The Hub administrator page is an independent full page with its existing Sign out
controls, not a backdrop-dismissed client dialog. Its server, routes, permissions
and UI are unchanged by this work.

## Verification

The new DOM cases cover shared-IP and same-name grouping, binary legacy ownership,
sharing direction, exact Bot message identity, collapsed sections, a conflict
refresh without mutation replay, direct toolbar navigation, Back/Close/Escape
focus restoration, duplicate Message clicks and late results after dismissal.
Existing request/publication and reply/group UI cases remain part of the full
plugin regression.

Run from `ds-bot/` after installing the documented test harness:

```sh
npm run build
npm test
node scripts/build-client.mjs --check
npm run lint
node --import ./test/harness-resolve.mjs --test test/communication-directory-ui.test.js test/communication-usability.test.js
```

All tests use synthetic state or the deterministic Mock; no real model or account
is accessed. Actual Chromium visual checks were attempted but could not launch:
`browser/process_singleton_posix.cc:297`, `socket() failed: Operation not permitted
(1)`, followed by `SIGABRT`. The formally reviewed execution path produced the
same environment restriction. No screenshot, pixel-layout pass or real-browser
interaction result is claimed. Desktop, phone and dark-mode pixel verification
remains pending in an available authorized browser environment.
