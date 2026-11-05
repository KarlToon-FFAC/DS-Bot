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

At the initial approved snapshot, team collaboration changes were excluded: independent review found that the earlier branch marked a reply complete at local enqueue time and could suppress a useful final reply after Hub rejection. The follow-up integration below supersedes this blocker.

At that checkpoint busy-Bot supplemental input and read-in receipts were still pending. The follow-up below integrates them and records the remaining verification gates.

## Team integration follow-up

The implementation through `9f3e6d1` was selectively integrated without merging the mixed checkpoint ancestry or the review-only identity-memory proposal `ea49f3d`. Latest message-window behaviour, LAN HTTP identifiers, Hub lifecycle fixes and learning persistence safeguards remain intact. Client source conflicts were resolved and the generated client rebuilt.

Independent review confirmed the accepted-publication gate: pending/unknown tool sends retain the final, acceptance consumes it, and permanent rejection permits the substantive final export. Supplemental input remains bound to the original author, recipient, membership epoch and Session; model-step read evidence is distinct from successful understanding.

An additional recovery defect was fixed during integration: pending `targetStored` receipts must reach the Hub before `updateRead`, and both precede final publication. The regression starts with read/storage receipts in the opposite order, checks storage ACK loss retains both, and verifies the final publishes only after read evidence.

Integrated verification:

- Focused collaboration, updates, onboarding, Hub profiles and interface: 103 passed.
- Hub full suite: 105 passed.
- Plugin full suite: 1,703 passed, 3 failed, 2 skipped (1,708 total). The same protected-home and two native DPAPI environment failures remain.
- Build, generated-client freshness, lint and tracked-source secret scan passed; no mandatory scan findings.
- The combined build completed all 52 native DSH Mock smoke steps in a fresh loopback-only profile; both owned child processes stopped and the runner exited successfully. This is separate from the outstanding real-model integration gate.
- Synthetic migration rehearsal used the actual published v3 store implementations for both client and Hub, retained existing rows across v4 upgrade, verified old binaries reject upgraded stores, and restored v3 backups successfully. It did not touch real profiles or test an interrupted filesystem backup.

Hub and clients require coordinated schema 4 / capability upgrades. Stop all writers and take a consistent backup of the selected Hub and client stores before deployment; rollback restores those matching pre-upgrade backups together with the old binaries. Merely reverting code cannot open v4 stores.

Separate-worktree real-model evidence is preserved in `input-updates-evidence.json`; it is not a final combined-build model run. The combined real-model gate remains outstanding because the existing credential launcher is a Windows PowerShell file blocked by the current Restricted execution policy. No policy change, script-policy bypass, credential copy or real model request was performed for this integration.
