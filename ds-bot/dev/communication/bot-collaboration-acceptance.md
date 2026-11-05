# Bot collaboration acceptance

Run `node ds-bot/dev/communication/bot-collaboration-acceptance.mjs` from the repository root.
This uses real DSH A/B hosts, a separate real Hub process and deterministic local
Mock models on same-machine loopback. The ports are 3181/3182, 8881/8882 and 3198;
all must be free. Each run creates fresh `bot-collab-<nonce>` profiles. The hosts
and Mock endpoints inherit the owner-PID watchdog, the Hub closes on parent IPC
disconnect, the run has a 12-minute deadline, and cleanup verifies all five ports
are released. Only this run's owned process manifests are stopped.

The script tests passive structured final handoff Human -> A -> B -> A, active
explicit tool targets and validated input causation, passive unsolicited denial,
single/@all/quoted final restatement with no activation, explicit all-Bot handoff
excluding Humans/self/nonmembers, a depth-eight stop, and 35 active tool sends
sharing one input/target with exactly one Bot dispatch (34 DUPLICATE_HANDOFF).
Aggregate root-budget coverage remains in the independent Hub unit suite.

The recovery case pauses the real host after durable final export, stops and
restarts it, and duplicates one real authenticated Hub socket delivery. Public
test-probe session inspection and canonical Hub events prove stable message IDs,
root/parent/depth correlation, single-use grants and one logical DSH input.
It does not call private DSH endpoints or alter DSH internals.

The isolated Mock recognizes only the new `COMM-COLLAB` FINAL, DONE, ALL and BURST
commands. BURST is bounded to at most 40 tool calls. No real keys, user profiles,
SSH, VirtualInput, external requests or real models are used. Private evidence is
saved under `.dsh-test-tools/bot-collab-*-acceptance.json`. A first failure stops
the run and does not claim later cases passed. Physical-machine networking and
real model/GUI behavior remain outside this acceptance.
