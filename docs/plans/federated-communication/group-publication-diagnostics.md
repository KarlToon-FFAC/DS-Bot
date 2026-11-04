# Group creation and Bot publication diagnostics

The external user's CA issue is reported resolved and Hub enrollment succeeded.
We cannot access that machine. This does not establish whether its group creation
or Bot publication committed, nor which installed versions it is actually running.

## Confirmed code findings

Both operations first enter the authenticated local communication route and its
runtime initialization (`ensure`). Group creation then uses a durable local
operation, an authenticated Hub request and the Hub's idempotent operations table.
Publication instead edits the local DS Bot config through the public ConfigEditor;
normal reload reconciles the published identities with the Hub. They do not share
one Hub mutation. Missing preset APIs, configuration editors, active configuration,
credentials or incompatible versions can block the shared initialization path.
These are hypotheses for the remote incident, not its established root cause.

Two actual client defects were found:

1. Unmapped errors became one generic sentence, and ContactManager discarded the
   caught error altogether. Configuration, initialization and transport failures
   were therefore indistinguishable. Shared safe descriptions now show known error
   codes, with translations; arbitrary exception messages and unknown strings are
   never rendered. Existing enrollment phase diagnostics remain available.
2. The operation journal removed an ID for every error with a code, including
   REQUEST_TIMEOUT and CONNECTION_LOST. The Hub may have committed before that
   response was lost; a new ID could create a second group. Only definite
   validation/authorization rejections now release an ID. Transient and unknown
   outcomes retain it across retries and browser remount. No automatic new group
   intent is created by this fix.

ContactManager also has a read-only refresh. Local publication configuration is
shown independently of failed Hub contact/code reads. A save whose response was
lost can be confirmed from effective settings without another publication write.
This confirms local configuration only; Hub-side reconciliation is a separate
observable state. No server authorization or schema change is made by this patch.

## Safe external evidence needed

Do not press Create or Save published Bots again to collect diagnostics. Preserve
the current request/operation IDs. Read the existing failed request in the browser
Network panel, if it is still present: only report `error.code` and `error.phase`.
Do not export HAR, headers, cookies, Hub/user codes, full config or environment.

On the affected DS Bot page, its local AI can use this read-only same-origin check:

```js
const read = async endpoint => (await fetch('/api/communication', {
  method: 'POST', headers: {'content-type':'application/json'},
  body: JSON.stringify({endpoint})
})).json();
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
const state = await read('state'), publication = await read('available-bots');
const value = state.value ?? {};
console.log({
  stateOK: state.ok, stateError: safeCode(state.error?.code),
  enabled: value.enabled, connected: value.connected, reconciled: value.reconciled,
  runtimeError: safeCode(value.error), groups: value.conversations?.filter(x=>x.kind==='group').length,
  groupOperations: (value.outbox ?? []).filter(x=>x.type==='group.create').map(x=>({
    operationId:x.id, state:x.state, error:safeCode(x.error), conversationId:x.result?.conversationId ?? x.conversationId
  })),
  publicationOK: publication.ok, publicationError: safeCode(publication.error?.code),
  configuredPublishedBotCount: publication.value?.publishedBotIds?.length
});
```

This reads through the already authenticated browser; no credentials are copied.
Operation/conversation IDs are correlation identifiers, not credentials. Redact
them when posting publicly; retain them privately for the owner to compare with
the Hub's operations and group membership. An accepted result/conversation ID
confirms creation. Pending or absent local data alone does not prove Hub rollback.
Do not infer successful Hub Bot publication solely from a saved local selection.

Also report the client and Hub commit IDs, DSH version and Node version. In
particular, 17b0134 requires matching explicit-bot-activation peers and schema v3;
no real deployment or database migration is performed during this diagnosis.

## Local validation

Mock UI regression: a coded REQUEST_TIMEOUT preserves the same creation ID through
a full surface remount; publication shows CONFIG_EDIT_OVERLAID and its phase;
failed Hub reads do not hide local publication state; refreshing after a simulated
save/ACK loss updates the selection without another write. A real HubStore/local
queue test commits a group, loses the ACK, then reconciles the same ID to exactly
one group. Error tests retain unknown outcomes and exclude raw exception content.
Full plugin regression, generated bundle freshness and lint are recorded after run.

Executed local verification: 1642 plugin tests passed, two existing skips (1644 total).
Generated-client freshness and lint passed. The source-only review scan found zero
must-fix findings. These are local Mock/component/HubStore results, not evidence
that the external user's original group or publication succeeded.
