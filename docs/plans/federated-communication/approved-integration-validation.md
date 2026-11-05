# Approved integration validation

This snapshot starts at `a9e389d`, not the mixed `9ca5833` checkpoint. It combines the approved learning (`8ce60c9`), Hub lifecycle (`a476a40`) and message interface (`fbb9c80`, `fdf03f4`) changes without importing the experimental tool-reply completion mechanism.

The integration also exposes revoked-access status checks for departed identities, so administrator repair can be observed before the user explicitly resumes. Forgetting a Hub now states that communication queues and cached files may be deleted while DSH session journals and browser drafts remain.

## Evidence

- Focused learning, onboarding, Hub profile and interface tests: 133 passed.
- Plugin full suite: 1,690 passed, 3 failed, 2 skipped (1,695 total).
- Hub full suite: 104 passed, including strict TLS checks.
- Build, generated-client freshness, lint and whitespace checks passed.
- A fresh isolated DSH profile started through the public Node profile-boot entry completed all 52 native Mock smoke steps. Both owned child processes stopped. This used loopback networking and synthetic data only.
- Desktop, narrow-screen and read-only dark reply-window screenshots are recorded in `message-actions-acceptance.md`. These interface checks use synthetic fixtures and do not establish physical-machine interoperability.

The three full-suite failures are environment restrictions, not passing checks: the avatar test cannot resolve the protected home directory; two native DPAPI tests cannot execute their Windows PowerShell script under the effective Restricted execution policy. No policy was changed or bypassed. Native credential lifecycle verification remains outstanding in a supported environment.

## Integration gates

Team collaboration changes are not part of this snapshot. Independent review found that the team branch inherits a candidate that marks a reply complete at local enqueue time, before Hub acceptance, and can suppress a useful final reply after rejection. Importing only later deltas would instead leave prompt/tool descriptions inconsistent with the runtime. This contract must be resolved before release.

Busy-Bot supplemental input and read-in receipts are also still pending. Earlier real-model experiments from a separate worktree are supporting evidence only; they do not verify this combined snapshot. A final combined full regression, controlled real-model check, remote push and CI verification remain required.
