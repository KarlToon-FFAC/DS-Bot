# Follow-up acceptance

Branch `chore/federated-communication`; baseline `4b90828`. This batch is not
committed or pushed. All new development tests use isolated local Mock instances;
real WSS/DSH means real transport/host components, not physical cross-machine tests.

| Requirement | Implementation / positive evidence | Negative case or limit |
| --- | --- | --- |
| Full local-style layout | Original/remote actual screenshots compare sidebar, header, transcript, composer, dark/light, DM, narrow and readonly | Remote identity/authority remains distinct from local groups |
| Gear/search/+ /collapse | `communication.js` and styles; native actual UI/source comparison; real menu/search/collapsed/390px screenshots; keyboard tests | Search covers current titles, contacts and recent summaries, not full archive; menu/search never sends |
| DM/group creation submenu | Both actions open existing pickers | Partial invite failure retains original group; no duplicate creation |
| Chinese initials | One Han character; multilingual, tiny and group renderer tests | English keeps two initials; local Bot shape/image remains authoritative |
| Code-only CA pairing | Signed v2 public CA, strict chain/name/date/Hub binding; real WSS A/B without ambient CA | No TLS disable/system trust edit; code must come from trusted channel; wrong signature/CA/name rejected |
| Compatibility/rotation | v1 strict existing TLS; explicit reviewed update-hub-trust; SDK version fences | Hub ID alone is not a pin; existing identity cannot silently adopt another CA |
| Independent admin webpage | Native-style login/devices/mobile screenshots; client/DSH links removed | Independent configured HTTPS `/admin/`; no fictitious client entry |
| Remember password/login | Native autocomplete form delegates saving to browser manager; protected cookie reload | No app password storage; CSRF/logout/session revoke/verifier rotation tests; no real account used |
| Disconnect/rejoin/switch | Local pause, explicit selection/resume, per-Hub queues/SDK keys/config/publication; real A/B/A acceptance | Selection does not enroll/send; status cannot resume; server revoke remains authoritative |
| Offline/crash/legacy | Durable pause/requiresResume and CAS; retained pending send delivered once; interruption/static-pairing tests | Unbound old queues are not guessed or moved; no real database migration |
| Cross-Hub UI isolation | Scope on history, drafts, profiles/settings, operation IDs and avatar cache; colliding-ID test | Late/old responses cannot display prior Hub history or reuse its draft |
| Network recovery | Refusal/timeout/unreachable classified transient; actual restarted Hub recovers | TLS, identity and pause errors remain terminal; uncertain writes are not blindly retried |
| Image/file transfer | Shared validator copies, queue/runtime, GUI/CLI/Skill; real WSS→DSH AttachmentStore→Mock reply and received-byte equality | Max 4 files / 64 KiB total plus envelope; large-file chunk transport absent |
| Attachment safety | Basename/base64/length/SHA-256/MIME/raster dimensions; authenticated message/history; inert download | Path/digest/SVG-as-image/size/readonly/outsider/removal/mixed-version negatives; no URL fetching or arbitrary file access |
| Attachment UI | Real DSH accessibility state verified raster/file cards; desktop screenshot captures restored chat at the latest message; React picker, file-only send, size and readonly tests | The saved screenshot does not show attachment cards in its viewport. Real chooser interruption not passed: tab disappeared; Hub contains zero attempted synthetic-browser filename messages. Real paste/drop/download interactions remain unverified |
| CLI/help/Skill/GUI | Packaged Skill semantic operation matrix; CLI schema/help endpoint parity; lifecycle and admin CLI | Delegated operator acts with explicit local user authentication; executing Bot cannot borrow Human/admin identity |
| Core prompt | Compact identity/permission/untrusted attachment hints, detailed Skill | No filesystem/secret tools or authority from group roles |
| Bot collaboration | Existing structured handoff, passive single final, @all, A→B→A, thread/epoch/dedup recovery retained | Body @/quotes/final summaries cannot wake Bots; causal/same-input limits remain |
| Reply/settings/member view | Existing nested rails/collapse, reference bubbles/jump, dirty Save/discard and readonly member view retained | Late/concurrent edits, stale grants and revoked reads denied |
| Contacts/names/errors | Existing IP grouping with stable IDs, Human profile, synced Bot appearance, compact accessible icons | No IP authentication/merging; no bottom console or routine membership-change notice |
| Memory/workspace | Baseline Memory 10000/Main Bot working-directory changes retained | No remote filesystem permission expansion |

Evidence: `.dsh-test-tools/hub-onboard-d08004b6-lifecycle-acceptance.json` and
`hub-onboard-42426e99-lifecycle-acceptance.json` each record six PASS stages and
cleanup. Full Hub run has 101 passes (`final-hub-tests.log`). Final plugin,
lint and bundle freshness outcomes are in the task report; previous regression
counts are not evidence that unfinished UI interactions passed.

Final verification after reconnect: plugin **1665 pass, 2 skip, 0 fail** (1667
tests); Hub **101 pass, 0 fail**; build, bundle freshness and lint exit 0. Lint
has nonblocking warnings. The focused interruption/legacy/prompt/CLI/UI run has
65 passes. Secret/scope scan covers 75 changed files and reports no matches for
live API keys, private PEM blocks or startup authentication URLs; ignored test
databases/files are outside the candidate change set.

A fresh real Chrome attempt opened the normal multi-file chooser successfully,
but `setFiles` was refused because the ChatGPT extension lacks **Allow access to
file URLs**. That setting was not changed and no alternative upload mechanism
was used to bypass it. Local-file selection/upload and corresponding real
paste/drop/download interaction are not marked passed. They require the user
to decide whether to grant that extension access. The existing React and real
WSS/AttachmentStore/Mock tests remain valid independent evidence.

After the user enabled the extension permission, fixture `c119931a` verified
real Chrome multi-selection of a 715-byte synthetic PNG and 48-byte text file,
one acknowledged send, image/file rendering on A and reception on readonly B.
Readonly B had no composer. Read-only Hub inspection confirms exactly one
canonical message with both original SHA-256 descriptors. Earlier uncertain
fixtures `42426e99` and `1c9ea252` each contain zero attempted browser-upload
messages, so no uncertain mutation was repeated. Screenshot
`screenshots/remote-attachments-sent.png` visibly includes both attachment cards
and the raster image; Library `libfile_dd935d1db8bc8191810a82ed721311a0`.

The subsequent real download call hung and was aborted. No further UI input
was issued after that interruption. The exact expected synthetic file was not
found in the standard Downloads directory, which does not prove whether another
download location was used; download is unconfirmed. Real clipboard paste and
drag/drop remain untested. Do not label all real-browser attachment interactions
passed based on the selection/send/receive evidence.

The final composer also stops file paste/drop event propagation so it cannot
reach the separate local-chat upload handler. React integration tests cover
both event types, preserved local draft, no automatic send and attachment draft
creation. This is automated event coverage, not a replacement for uncompleted
real clipboard/OS drag/drop interaction. After that fix, full plugin regression
is **1666 pass, 2 skip, 0 fail** (1668 total); build/freshness/lint pass. The
reviewed candidate set is now **76 files**, including the new real screenshot.

The interruption also stopped the earlier retained playground processes; its
`f5123170` profile data remains. A replacement fresh isolated playground
`5fd3e7ea` has passed eight native onboarding/permission/appearance/restart/trust
stages and uses `--keep-profiles`; current liveness is recorded separately in
ignored `current-play-health.json`. None of these fixture changes touch real
Hub data. The replacement is a new test identity, not restoration of deleted
or previous credentials.

Review images (Library uploads succeeded; Windows xattr writeback unsupported):

- Toolbar menu `libfile_4eec3ed01de081919448421d4a557ed7`, mobile `libfile_36f2de399d788191889048584a3b35b3`.
- Admin login `libfile_c5e07ed1fbfc8191a45dbbc63d1f8217`, mobile `libfile_1bf634a7828c81918bdad4c1345b8304`.
- Real restored desktop chat: `screenshots/remote-attachments-desktop.png` (historical filename; attachment cards are above this viewport).

The original 3185/3186 playground expired during the extended disconnect. Its
evidence records `cleanedUp: true, temporaryKeysDeleted: true`, and profiles no
longer exist. Code/screenshots/non-secret evidence remain. Do not claim that
playground still runs or preserves the trial data, or pretend fresh enrollment
restores deleted identities. Replacement requires fresh data and a clear
retention/lifetime policy. No production Hub, firewall or real device was changed.

Further real Chrome acceptance (`ae049d76`): PNG clipboard write plus actual
Ctrl+V created `clipboard.png`; an actual pointer drag from the displayed image
to the remote textarea created a second attachment. Each was explicitly sent
once and received once on B with the original 715-byte PNG SHA-256. Safe evidence
is in ignored `real-paste-drop-evidence.json`; screenshot
`screenshots/remote-attachments-paste.png`. This verifies browser image drag,
not cross-application Explorer multi-file drag. No synthetic DOM event was used
as evidence for these real interactions.

The prior download elicitation is visible in room history with no confirmation;
the exact standard Downloads file is absent. Browser navigation to
`chrome://downloads/` was denied by the URL policy (only HTTP/HTTPS allowed).
No alternate browser/native route was used to access that blocked history.
Download must use its normal approval mechanism, not a privileged-page workaround.

The 64 KiB inline limit is not attachment parity with the original local chat.
See `attachments.md` for the verified local 20 MiB/image, 20 images/message,
200 MiB aggregate defaults and recommended authenticated chunk/blob design.

One fresh normal receiver download attempt for `clipboard.png` was made after
the remaining work and review preparation. The tool waited for approval and
ultimately returned a download-event timeout. The exact `Downloads/clipboard.png`
file was absent at reconciliation; no second download was attempted. This is
an uncertain tool/browser outcome, not evidence of a product download failure
or a passing download test. Clipboard/image-drag evidence and the 77-file
candidate secret/scope scan are complete; download and Explorer multi-file drag
remain the explicit real-interaction gaps.
