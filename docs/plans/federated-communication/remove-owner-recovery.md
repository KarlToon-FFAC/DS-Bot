# Remove retained-owner recovery

This version no longer supports restoring a revoked group owner's membership or
ownership. This supersedes the retained-owner recovery behavior in older designs
and historical verification records.

## Cause of the reset residue

The local membership snapshot kept old records inactive when a Hub returned an
empty canonical membership list. The former recovery projection inferred an
action from those inactive local owner records, including records for groups that
no longer existed after a Hub reset. The button was therefore not evidence that
the reset Hub still had the group.

## Removal and compatibility

- Remove the recovery list, UI button, Bot tool, local API, CLI command and Hub
  RPC/store implementation. Regenerate the client bundle.
- Reject `group.reclaim` before reading a saved local intent or returning an old
  accepted result. Reject pending legacy recovery operations before any network
  request, including when connecting to an older Hub. Keep their audit status as
  failed and continue unrelated queued work.
- Remove only legacy browser operation IDs for the removed `reclaim` endpoint.
  Preserve unrelated operation IDs and their retry identities.
- Keep the old `OWNER_RECLAIM_REQUIRED` error code only as compatibility input,
  with a fixed message that recovery is unavailable. Current Hubs use
  `OWNER_UNAVAILABLE`. Historical `ownership.reclaimed` events remain readable;
  they do not grant a mutation capability.

## Authorization boundaries

Ordinary disconnect/reconnect and interrupted Bot work recovery are unchanged.
Group transfer, settings, ordinary membership, leaving and dissolution keep their
existing role, membership-epoch and version checks. Repairing a revoked device
does not restore any group membership or ownership. Administrators cannot inherit
an absent owner's privileges, and inviting that inactive owner cannot restore it.
The owner ID stays an authorization fence until explicit deletion/reset removes
the underlying data. The unused member-slot reservation for future recovery is
removed. Other members may use the full configured capacity.

This removal itself does not delete historical queues, messages, credentials or
model-session journals. Explicit complete reset and permanent device deletion are
separate operations and must clear their authorized scope without relying on an
ownership recovery path.

## Verification

Regression tests cover old UI snapshots and browser operation IDs, removed CLI
and API/tool entries, old accepted and durable pending operations, authenticated
legacy Hub RPC rejection without mutation, repair without restored membership,
old-epoch denial, owner/admin takeover denial, and normal group capacity.
All verification uses isolated synthetic data and deterministic local Mock
models. No real Hub, user data, external model or GitHub Actions is used.
