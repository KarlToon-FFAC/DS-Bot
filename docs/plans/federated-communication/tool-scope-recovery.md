# Communication tool-scope recovery

This change is local DS Bot scope maintenance. It does not modify DSH, the Hub
protocol, approval decisions, identity publication or remote execution rights.

## Verified mechanism

`tools.js` used one `held.tools` flag per live Agent. Once true, later additions,
removals or replacements in `rt.teamTools` were ignored. A registration conflict
also set this flag true, preventing a later retry. Normal complete plugin unload
and reload already had a live-Agent rescope path and a regression test; those
facts alone do not establish the exact cause of a user's reported disappearance.
Forced overlap between old and new plugin scopes reproduces a temporary conflict
that the old cache could leave permanent. We do not claim that every publication
causes such an overlap, or that a configuration-write race has been observed.

The pinned DSH builds its tool schemas before `system-prompt/assemble`, and runs
`agent/pre-step` after assembly. Merely registering a missing tool inside either
hook cannot update schemas already collected for that request.

## Recovery

- Reconcile once at the end of module installation, after every definition is available. Reconcile later definitions by exact name and definition identity. Add or retry only
  missing definitions, release withdrawn/replaced owned definitions, and keep
  unrelated definitions, restrictions and active dispatched calls intact.
- Inspect the public scoped registry when available. A foreign registration is
  never removed to make room for DS Bot.
- Reconcile at normal state/load synchronization and request boundaries. If
  assembly discovers an actual change, rebuild once through the public
  `systemPrompt.assemble(context)` API. Never append raw registry schemas to an
  accepted model assembly: that could bypass PTC or another plugin's filters.
- Bound rebuild recursion. An unresolved conflict remains visible as `partial`
  and is retried at a later boundary, without an infinite model or assembly loop.
- Wrap registered tools with an entry-time generation/ownership check. Mark entries inactive before disposal; failed cleanup leaves a retired, denied tombstone, even if the plugin guard has already unloaded. Already-dispatched calls retain their original definition.
- Stop the old maintainer before disposal. Delayed old load/Agent callbacks
  cannot restore old definitions after reload. Sessions owned by isolated
  communication explicitly receive no local team-tool rescope.
- Preserve current approval/runtime binding. This change does not update a
  previously approved operation to a different Hub or runtime, nor replay a send.

Diagnostics report observed scope state, names that failed registration,
`lastRefreshedAt` and a refresh count. `lastReloadAt` remains null because there is
no reliable host reload timestamp here. These observations are not proof of
model consumption, publication or current Hub authorization. DSH serializes model work per Agent; an independent concurrent inspection assembly can still retain an earlier snapshot while a rebuild is in flight. Such a snapshot grants no execution authority, and this change does not claim every concurrent inspection immediately observes the new schema.

## Mock evidence

Unit coverage includes added/replaced/withdrawn definitions in the same Session,
registration conflicts and retries, removed registry entries, normal reload,
overlapping old scopes, delayed old callbacks, remote ownership, bounded
reassembly, native/PTC filters and an already-dispatched definition completing
without changing identity mid-call. No real model or remote CI is invoked.
