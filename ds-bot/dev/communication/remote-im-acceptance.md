# Remote communication CLI acceptance

Run from the repository root with `node ds-bot/dev/communication/remote-im-acceptance.mjs`.
This starts two real DSH hosts, two deterministic Mock model endpoints and a real Hub
on same-machine loopback, using ports 3151/3152, 8851/8852 and 3197. Every run uses
fresh `remote-im-<nonce>` profiles. It verifies the ports are free before starting.
The existing owned-process bench manifest limits cleanup to this run's processes;
the host's owner-PID watchdog and a 12-minute overall deadline bound abandoned runs.

All CLI calls run as separate Node processes with JSON stdin. Session cookies come
only from this run's isolated profile login, remain in process memory/environment,
and are never printed or written to the evidence. No SSH, real model, real user
profile, real credential or VirtualInput access is used.

The private `.dsh-test-tools/remote-im-*-acceptance.json` records completed cases,
operation counts and the first failing assertion. A failing run stops, cleans up,
and does not claim subsequent cases passed. This covers local end-to-end behavior,
not cross-physical-machine acceptance. Human uniqueness/legacy compatibility and
recovery fault injection remain in the dedicated Hub/recovery suites.

The end verifies that an owner cannot leave without transfer, then stops its own
hosts and Hub, revokes B in the isolated fixture and reconnects B at a higher
pairing revision. Membership and ownership remain inactive, and no recovery list
is exposed. A newly created group can still be dissolved normally.

`@all` evidence compares canonical Hub deliveries and authors: exactly the current
two group Bots get AI deliveries and one granted reply each. It includes a third
published Bot outside the group as a negative control, native-Chief model-call
counts, passive proactive-send denial, removed-member routing, and original-request
retry after both membership and display-name changes. Changed raw text with the
same message ID must conflict.
