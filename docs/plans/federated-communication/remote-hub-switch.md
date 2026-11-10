# Local Remote Hub switch — V0.3.0

The user requests a local General setting, **Enable remote Hub**. A fresh install
starts off. An old configuration with an already configured/joined Hub defaults
on only while the new explicit setting is absent. An explicit false is never
replaced by that migration inference. The switch is independent of connection
pause/resume and Hub selection.

The local sidebar entry and restored remote surface are unavailable while off.
Host APIs and existing Agent communication tools are also gated; hiding a button
is not the permission/control boundary. Local settings, diagnostics and retained
configuration metadata remain readable. Only the authenticated local Human API
can change the switch; it is not a remote Session tool.

Disabling requires a separate confirmation dialog and a server-checked confirmation
plus configuration version. The warning explains withdrawal of this device's
published Bots from the currently selected Hub, permanent retirement of their
remote identities, loss of their group memberships/roles, read-only old private
chats, potential interruption of remote work, and the need to republish new
identities and explicitly add them again. Local Bots, files and local chat history
are retained; Human enrollment/contact/history data are not reset.

Before a Hub is configured, the switch is a DS Bot local preference saved through
the team's required, writer-locked state save. It takes effect immediately without
ConfigEditor or a DSH reload. A failed save restores the old value, and setup is
not authorized while the save is pending. This applies only with no active Hub,
no retained published Bot list and no pending withdrawal. Startup configuration
overrides therefore cannot prevent a fresh user from exposing the setup UI.
State requests load this preference before applying feature gates after restart.
An approved first enrollment or selection promotes an enabled setup preference
to the explicit profile flag through the normal public configuration transaction.
Once a Hub is configured the local setup preference is ignored, so it cannot
revive an explicitly disabled Hub or bypass withdrawal.

For an existing Hub, a public ConfigEditor transaction saves the explicit switch, empties publication,
rotates withdrawal generations and records a durable pending withdrawal. The
running Host immediately fences remote use and closes its normal runtime. A
minimal cleanup connection authenticates only to withdraw publication; it never
pumps outbox messages, pulls AI deliveries, starts model turns or executes tools.
It retires local publication identities too. Hub failure leaves an explicit pending
state and retries with bounded backoff, including after Host restart. The local
feature stays off even while remote withdrawal is pending. A successful Hub ACK
records a durable completion in the scoped local communication journal, keyed to
the unique withdrawal intent. This avoids configuration writes from a plugin
activation/reload transaction. Restart reads that completion before opening a
connection, and the next explicit setting change clears the saved pending flag.
The signed enrollment's remembered configuration also clears its published list
so a later Hub switch cannot restore it. Credentials and trust stay scoped to the
same Hub.
A paused signing credential can be used only for this locally authorized pending
withdrawal, without resuming ordinary queued work.

Enabling never restores the previous published list. While withdrawal remains
pending, normal communication/publication stays gated; the setup/trust actions
needed to restore connectivity remain accessible when the user enables the UI.
After cleanup and supported configuration reload, the retained Human enrollment
can reconnect with zero published Bots. A later explicit publication uses fresh
remote Bot identities and inherits no old membership or role.

Changes are client controls and use the existing Hub publication protocol. Hub
and plugin releases become V0.3.0; the wire protocol and capability requirements
are unchanged. Verification covers default/migration/explicit-off behavior,
confirmation and stale-version denial, online/offline withdrawal, restart,
no queued-message replay during cleanup, re-enabling without publication, lifetime
rotation, local settings/sidebar GUI and the standard regression/smoke checks.
