# Reply routing and atomic settings acceptance

Run `node ds-bot/dev/communication/reply-settings-acceptance.mjs` from the repository root.
This uses two real DSH hosts, a separate real Hub and deterministic local Mock models
on same-machine loopback. Ports 3183/3184, 8883/8884 and 3199 must be free. Each run
uses fresh `reply-settings-<nonce>` profiles. The hosts/Mock inherit the owner-PID
watchdog, the Hub closes on parent IPC disconnect, a twelve-minute deadline bounds
the run, and cleanup verifies all five ports are released.

It verifies Human no-mention replies activate the original current Bot; explicit
Bot mentions override the reply author; Human reply targets never receive AI;
active tools can explicitly reply without mentions; and automatic final response
correlation does not itself activate another Bot. Positive cases inspect actual
DSH communication inputs and match their sources to canonical AI deliveries and
single-use final grants. Removed/rejoined old-epoch references fail without Hub
messages or AI deliveries. `@all`, depth-eight and per-root AI32 budgets regress.

The real CLI `save-settings` operation changes title, routing and multiple policies
in one version increment. Exact original-request retry is idempotent; unauthorized,
invalid-policy, stale-version and changed-same-ID requests cannot partially change
title, routing, role or speech. CLI JSON uses stdin and session cookies obtained only
from this run's isolated profile login, held in environment/memory and never printed.

The only added Mock helper is `COMM-COLLAB REPLY <conversationId> <messageId> <tag>`,
which calls the real communication send tool with an explicit reply reference and
no mentions. Previous acceptance scripts are unchanged. No real credentials, user
profiles, SSH, VirtualInput, external requests or private DSH interfaces are used.
Private JSON evidence is saved in `.dsh-test-tools/reply-settings-*-acceptance.json`.
Physical-machine, real-model and GUI behavior are outside this script.
