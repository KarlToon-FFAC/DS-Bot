# Current Remote communication follow-up matrix

**Historical planning snapshot.** Current implementation and honest remaining
boundaries are recorded in [followup-acceptance.md](followup-acceptance.md).
In particular, the original playground has since expired and was cleaned up;
the final sentence below is historical, not its current state.

This supplements, rather than replaces, `scoped-trust-ui-acceptance.md` and the
earlier P0–P4/security/anti-echo evidence. No production or current playground
Hub is used for destructive lifecycle or attachment tests.

| Requirement | Current implementation / evidence | Remaining |
| --- | --- | --- |
| Original-layout sidebar/header/messages/composer | Previous staged batch; real original/remote desktop, mobile, DM, dark/light, read-only screenshots | Retain while extending features |
| Native + submenu, search and sidebar toggle next to gear | New four-button toolbar, two creation actions leading to existing modals, scoped search palette, keyboard, full collapse and restore | Final broad regression; screenshots ready |
| Browser cleanup | 18 obsolete/duplicate tabs closed; A/B retained and working | Protected old `:3101` tab cannot be inspected; do not force-close |
| Signed code-only private-CA pairing | v2 signed code, exact scoped CA, trust update, rollback-fenced records; native A/B real WSS | Included in previous full suites |
| Independent admin UI/login | Native form/password-manager support, refresh/CSRF/revoke/rotation tested; product links removed | New local-style admin CSS preview and screenshot underway |
| One active Hub, isolated retained Hub data and switch back | User selected per-Hub retention, not independent-profile-only workflow | Implement explicit disconnect/select/resume with distinct queues and credentials; verify same-Hub rejoin, approval, identity/user code, offline/crash fencing and legacy adoption without moving real data |
| Human-only credential/trust lifecycle | Existing onboarding enforces Human authority; group role cannot grant it | Retain trust/keys per Hub intentionally; no accidental credential reuse or automatic purge |
| Chinese text avatar | One Han character for a Han-leading name; English keeps two initials; bounded avatar container | Add multilingual/small/group rendering tests and screenshot |
| Image/file send/receive/display | Current remote protocol is text/Markdown; local implementation must be examined | Design and implement authenticated bounded attachment transport/storage, GUI/CLI/Skill, permission/error/safety and isolated E2E; do not claim current text-only behavior supports files |
| Every permitted operation in GUI/API/CLI/help/Skill | Existing CLI schemas cover messaging, group lifecycle/policies, contact consent/publication/profile, enrollment and trust | Produce exact operator/Bot/admin matrix, add missing safe lifecycle/admin surfaces and help; test denied authority |
| Core system prompt | Existing identity/privacy/anti-injection/anti-echo and communication tool summary retained | Only core additions; detailed operation/reference goes in Skill |
| Group collaboration/routing | Existing A→B→A, explicit activation targets, passive final grant, @all, thread/epoch, dedup/recovery and loop bounds | No regression; attachments must not imply activation |
| Reply UX/settings/member visibility | Existing implicit Human reply targeting, bubble reference, non-locking jump, branch rails, one dirty Save/discard, read-only member information | No regression |
| Contacts/profiles/appearance/errors | Existing stable instance IDs and observed-IP grouping, local Bot appearance, Human profile, compact sender icons, modal pickers and non-chat failures | No regression; Chinese avatar correction included |
| Prior local Bot changes | Memory 10000 and Main-Bot workspace changes are in baseline implementation/test coverage | No scope expansion to remote machine files |

The prior full result was 1648 plugin passes plus two skips and 96 Hub passes.
The navigation/avatar/i18n focused run currently has 47 passes. These numbers do
not mean the unfinished lifecycle or attachment requirements are complete.

Review images uploaded:

- Toolbar submenu: `libfile_4eec3ed01de081919448421d4a557ed7`.
- Toolbar at 390px: `libfile_36f2de399d788191889048584a3b35b3`.

Windows Library xattr writeback is unsupported; the actual uploads succeeded.
The working tree is not pushed. Current playground data remains intact.
