# Fresh Remote Hub enable and local configuration errors

2026-11-10. Keep V0.3.1 and the existing communication protocol.

Enabling Remote Hub is a local profile edit. It does not require a Hub address,
enrollment, published Bots or a working Hub connection. Native DSH 0.2.1-rc.4
with an empty profile patch can enable it normally.

## Reproduced failure

With a home or command-line patch overriding the `bot` configuration, the public
DSH ConfigEditor refuses to save a profile edit. It reports a plain Error rather
than a coded exception. Enrollment/publication already recognized those exact
public errors, but the Remote Hub switch did not. The HTTP sanitizer converted
the uncoded rejection into `COMMUNICATION_UNAVAILABLE`; the UI incorrectly told
the user to wait for a connection even though no Hub was configured or contacted.

Share the existing exact ConfigEditor diagnostic mapping with the switch.
Retain coded local preconditions and report uncategorized editor failures as
`COMMUNICATION_CONFIG_WRITE_FAILED`. Expose only fixed codes and the configuration
write phase; private exception messages, entry names and paths stay private.
The UI explains that configuration overrides must be moved into the active
profile's `cordis.patch.yml`, followed by a DSH restart. Other local write
failures ask the user to check profile permissions and active configuration.
Failed saves leave the switch, publication and communication runtime unchanged.

This respects the public configuration editor's ownership restriction. It does
not silently write home patches, remove command-line overrides, pretend a failed
save succeeded, or patch DSH. Existing disable/withdrawal and reload semantics
remain intact. A generic screenshot alone cannot prove this was the reporting
user's exact local failure; their DSH version and installation/launch mode are
still needed if the new error identifies a different cause.

## Reproduction and verification

`node ds-bot/dev/communication/remote-hub-enable-acceptance.mjs` uses one fresh
owned native DSH profile and deterministic Mock, without starting a Hub:

1. A default-off, unconfigured profile enables locally and applies through reload.
2. A real startup patch overriding Bot config refuses the save with
   `CONFIG_EDIT_OVERLAID`; the feature stays off. The same setup returned
   `COMMUNICATION_UNAVAILABLE` before the fix.
3. Removing that test override and keeping Bot settings in the profile allows
   enabling. The setting persists through host restart.

HTTP regression tests cover overlay, stale/replaced entry, disposed editor,
invalid YAML document and unknown private filesystem exceptions. A GUI regression
checks the actionable local error and the unchanged off switch. Existing
enrollment error mapping is preserved. Full plugin tests, generated-client
freshness, lint and native 52-step smoke are checked for this fix.

Final results: 2,094 plugin tests, 2,089 passed, five skipped and zero failed.
All three native enable/overlay/restart cases and all 52 native smoke steps pass.
Lint and generated-client freshness pass; pre-existing lint warnings remain.
Owned test processes are stopped after validation.

These checks use synthetic Linux profiles only; no real user data, Windows host,
credentials, model service or production Hub is accessed.
