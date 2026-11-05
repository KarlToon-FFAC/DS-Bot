# Two-machine trial and rollback

For current clients, the normal setup is a signed v2 Hub code reviewed through
Remote communication settings. It supplies public CA trust for the exact Hub;
no manual client CA environment setup is required. Static configuration below
is a legacy fallback, not the preferred enrollment path.

This branch implements P0–P4 and the additional group governance and prompt
isolation requirements. It is ready for a controlled trial. Acceptance so far
uses independent DSH A/B processes on one Windows computer. Local WSS uses the
production client transport and normal certificate verification. Different-IP
operation, your network/certificate installation and packaged Electron behavior
have not been accepted by those tests. Do not treat a readiness response as proof
of pairing, authorization or model completion.

## Prepare the two clients

### Recommended: Hub-managed enrollment

For a new pairing, use the Hub management page rather than editing credentials
into either client. Enable `management.enabled` on the Hub, provide its private
administrator password through `management.adminPasswordEnv`, and configure a
reachable trusted `wss://.../communication` address in `management.url`. The Hub
prints its `/admin/` address. The Hub code includes its actual address and stable
ID; it does not discover machines, open ports or traverse NAT.

On each client choose **Remote communication → Add a device**, paste the Hub code,
review its address and ID, then explicitly request access. The Hub administrator
checks the applicant and key fingerprint before approving. Use **Check approval**
on the client to apply the supported configuration-editor update and reload.
Existing settings are preserved; a configured client cannot silently switch Hubs.
The signing key stays in the client's credential provider. Its default provider
uses an OS-account-protected plaintext file, not encryption; same-user programs
may read it. No private key belongs in a Hub code or chat.

Use **Manage contacts** to select local Bots to publish and exchange Human user
codes. A request alone grants no contact access: both Humans explicitly confirm
their own shared Bot scope, defaulting to none. Then open a DM or invite approved
contacts to a group. Every participant can inspect group members; only authorized
roles can save changes. Revoking contact consent stops DMs and new invitations;
an existing shared group retains its separate permissions.

See the [Hub run instructions](../../../communication-hub/README.md) and
[management design](management-design.md) for approval, revocation, repair, CLI
and credential boundaries. Upgrade the Hub before clients. The manual static-peer
procedure below remains a compatibility path for an existing installation.

Use Node 24 or newer and Git. On **each** computer, clone the branch into a new
directory, without copying the other computer's profile or credentials:

```powershell
git clone --branch chore/federated-communication --single-branch https://github.com/KarlToon-FFAC/DS-Bot.git DS-Bot-federated
cd DS-Bot-federated
git rev-parse HEAD
.\start.ps1 -DataRoot .ds-bot-local/trial
```

Use the same commit on both machines. The source launcher installs dependencies,
builds the local plugin and, if absent, downloads Electron. It does not install a
Windows service. The first launch requires the app's normal provider setup; use
a synthetic test team with a model you already authorize. Quit the app before
editing its profile. Closing its window can leave the app running in the tray;
use **Quit**.

For this command the isolated data directory is
`.ds-bot-local/trial/data/`, and the app profile patch is
`.ds-bot-local/trial/data/profiles/ds-bot/cordis.patch.yml`.
Read the test Bot's ID from the app or its own `data/bot/state.json`; do not copy
the whole state file into a chat or another profile. Merge this into the existing
`id: bot` row's `config`, preserving other settings:

```yaml
- id: bot
  config:
    communication:
      enabled: true
      instanceId: trial-a
      url: wss://hub.example.test:3190/communication
      credentialEnv: DSBOT_COMMUNICATION_CREDENTIAL
      humanDisplayName: Trial person A
      publishedBotIds: [REPLACE_WITH_LOCAL_BOT_ID]
```

Computer B uses `trial-b`, its own local Bot ID and display name. Choose stable,
distinct instance IDs before first enabling communication. Do not delete or copy
`communication.sqlite` to repair pairing. Bot publication is explicit: an
unpublished local Bot will not run new communication turns and publication sync
removes it from contact discovery and future AI recipients. Historical group
identity remains visible as unpublished. Peer revocation, rather than removing a
local configuration entry, is the authoritative way to revoke a whole machine.

Supply `DSBOT_COMMUNICATION_CREDENTIAL` privately to the launching process,
using that machine's existing secret mechanism. Never put its value in YAML,
command arguments, screenshots, Git or messages. Start the same command again
from that environment. The adapter consumes the credential before model/tool
execution. The OpenAI DPAPI helper below is for the isolated acceptance launcher;
it does not automatically configure providers in the normal desktop app.

## Run one Hub

Run the Hub from the same checkout on a machine reachable by both clients. Keep
the database on that machine's local disk. Create `communication-hub/local/`
(ignored by Git) and put this non-secret config in `local/hub.json`:

```json
{
  "host": "0.0.0.0",
  "port": 3190,
  "databasePath": "./hub.sqlite",
  "tls": {
    "certificateEnv": "DSBOT_TLS_CERT",
    "privateKeyEnv": "DSBOT_TLS_KEY"
  },
  "peers": [
    { "instanceId": "trial-a", "instanceLabel": "Trial A", "pairingRevision": 1,
      "credentialEnv": "DSBOT_HUB_A_CREDENTIAL" },
    { "instanceId": "trial-b", "instanceLabel": "Trial B", "pairingRevision": 1,
      "credentialEnv": "DSBOT_HUB_B_CREDENTIAL" }
  ]
}
```

The Hub operator supplies the existing TLS certificate/private key as PEM values
through the named private environment variables. Supply distinct, high-entropy
pairing secrets of at least 32 characters; each must match its client's
`DSBOT_COMMUNICATION_CREDENTIAL`. An OpenAI API key is **not** a pairing secret.
No production secrets or certificates are shipped or generated by this guide.

```powershell
npm.cmd ci --prefix communication-hub --no-audit --no-fund
npm.cmd start --prefix communication-hub -- ./local/hub.json
```

Use your real Hub name in both client URLs. The certificate must match that
name/IP. For normal enrollment, use a signed v2 Hub code from a trusted channel.
The client validates its public CA trust and binds it to the exact Hub ID and
URL; no client CA environment setup is required. The static legacy flow below
does not bootstrap private-CA trust: prefer upgrading to signed codes or use a
certificate already trusted by that deployed client. TLS-intercepting proxies
require separate administrator review, not a blanket CA override.
Do not disable certificate validation. Non-loopback plaintext `ws://` is refused.
Network reachability and an existing trusted certificate remain deployment
prerequisites; this work changes no firewall rules, system trust or services.

An HTTPS `/health` response proves readiness only. Ctrl+C stops the Hub normally.
Removing a peer from config and restarting revokes it durably. Re-pairing requires
a larger `pairingRevision`; reconnecting alone does not restore group access.
Ownership recovery is unavailable. Ordinary members require fresh invitations. Old revoked deliveries do not return.

## Verify in the real environment

Use synthetic text and record both commit IDs, sanitized errors and message IDs.
Do not record startup authentication links or secrets.

1. Confirm each client's **Communication** entry is connected and displays the
   other machine's Human and published Bot with distinct complete identities.
   Same display names must still select distinct participants.
2. Test Human→Human, Human→Bot, Bot→Human and Bot→Bot DMs. Confirm a single
   canonical conversation in reverse direction and no response from a Human's
   private Chief when messaging that Human.
3. Create one group, invite both Humans and Bots, and explicitly accept the
   invitations. New Humans start `readOnly`, Bots `passive`. Owner/admin role is
   separate from speech rights. An admin manages ordinary members and routing;
   only the owner appoints admins, transfers ownership or dissolves the group.
4. Grant the desired Humans `speak`. A passive Bot may reply once to an admitted
   AI delivery (for example an explicit mention), but cannot initiate with its
   group-send tool. Grant `active` only to Bots that may initiate. Verify read-only
   denial and a Human mention causing no model call. Verify a passive final reply
   with explicit @Bot can delegate to that member, while an unmentioned group
   reply causes no cascade. Bot collaboration remains bounded by the Hub causal budget. The default reply Bot setting does not grant administrator rights.
5. Disconnect B, send from A, restart B and confirm delivery with the same message
   IDs and no duplicate reply. Downgrade/remove a member while it is offline and
   confirm queued new publications are rejected after reconnect. Restart the Hub
   and confirm identities, membership and history survive.
6. Transfer ownership, verify the former owner cannot use owner-only controls,
   and verify the current owner's last-owner protection. Test hostile group text
   asking for private DM content; neither model input nor group history should
   include another conversation's canary. These checks reduce exposure; prompts
   alone are not an authorization boundary.

Attachments and business workflows are outside this text-only communication
scope. The trusted paired host can act as its own local identities; this is not
a sandbox against a compromised machine. The added communication model preset
allows only communication tools and persona configuration, not private file,
memory, shell or other-conversation tools. Task/tool side effects are not claimed
to be exactly-once.

## Reuse the local encrypted OpenAI record

On Windows, `ds-bot/dev/communication/openai-vault.ps1 -Action Status` reports only
metadata. `Set` and `Rotate` use hidden local input; `Delete -ConfirmDelete` removes
the record. The record lives at
`%LOCALAPPDATA%/DS-Bot/credentials/openai-official.dpapi`, encrypted with DPAPI
CurrentUser and an owner-only ACL. The same Windows user and administrators can
still decrypt it. Do not copy it to another machine or use the previously exposed
temporary key as a long-term key. See [encrypted reuse](openai-encrypted-reuse.md)
for the explicit-budget acceptance command. Completed budget ledgers intentionally
refuse repeat runs; do not delete/reset one to obtain unapproved calls.

## Stop, back up and roll back

Before a trial or upgrade, quit both clients and stop the Hub. Back up the entire
isolated client data directories and the Hub data directory while stopped to a
private location outside Git. Include database sidecars if present. Keep the
matching code commit and protect backups as private conversation data.

To stop new communication, disable `communication.enabled` and restart each
client; this does not erase history or revoke its Hub identity. Revoke the peer
at the Hub if access must end. Do not remove a last owner to work around a lock.

Hub schema 2 migrates schema 1 forward. An old binary is not a downgrade tool:
restore the matching **code and stopped-data backups together**, including each
client queue. Do not reuse an older database with newer peers continuing to write.
An empty trial can instead use a new, separately paired identity and fresh data;
do not erase an active identity's database or real-model budget ledger. No main or
documentation branch is changed by this implementation branch.
