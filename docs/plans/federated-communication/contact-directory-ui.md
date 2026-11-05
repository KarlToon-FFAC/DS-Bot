# Contact directory and management exits

The Remote communication toolbar now has a dedicated Contacts button. It opens
the contact directory directly instead of requiring Personal settings first.
Personal settings no longer repeats this entry. Its device enrollment action is
Join Hub (加入 Hub); Back returns to that exact launching control.

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
is accessed. The initial standalone Chromium launch was blocked by
`browser/process_singleton_posix.cc:297`, `socket() failed: Operation not permitted
(1)`, followed by `SIGABRT`. That launch was not retried through another path.

The follow-up used the platform's supported internal preview service with the
already running cloud browser. `sites-preview start <static-preview-directory>`
returned its exact browser URL; this successfully rendered the integrated
`eab655102ef79e7cd7ed8af1294fc9d70f94aa7d` communication components and production
shell/communication styles. No hosted Site, public deployment, sharing grant or
new browser process was created. Earlier arbitrary-port loopback refusal was a
preview connectivity problem, not proof that screenshots were unavailable.

The synthetic harness supplies authorized Humans, same-name Bots, one shared IP,
one active local-sharing scope and pending requests. The desktop screenshot and
390px dark iframe viewport show the real responsive CSS, avatars, contact cards,
long-name wrapping and dialogs. At 390px the document width is 390px and modal
scroll/client widths both measure 349px. After scrolling 489px, Close remains
visible at y=25–57px. The three management disclosures start collapsed, the
request count is visible and new sharing selections remain unchecked. Search for
Home laptop keeps only `human:b:person`, without sending a message. Back from
pairing restores Add a device focus.

AX activation additionally exposed that dialog focus restoration depended on the
browser first focusing the clicked toolbar button. Toolbar actions now explicitly
retain their event target, and the regression activates Settings while Contacts
still holds focus. This preserves the exact opener for Close/Escape even with
assistive-technology activation.

Screenshots: `contact-managed-desktop.jpg`, `contact-managed-phone-dark.jpg`,
`contact-managed-phone-requests.jpg`, `contact-managed-phone-pairing.jpg` and
`contact-managed-search.jpg`. They are synthetic review artifacts, not production
contact data. This verifies component rendering and interaction, not live Hub,
DSH transport, real-model behavior, physical-device networking or the full app's
Markdown integration.
