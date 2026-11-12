# V0.3.4 group communication and admission

This release implements the eight requested follow-ups without changing the
communication protocol or the explicit reply/no-reply contract.

| Request | Implementation and verification |
| --- | --- |
| First broadcast appears without F5 | Empty history has no forward cursor; fetch the latest page when the live watermark advances. The regression starts with an empty group and verifies the first Human broadcast, Bot response and subsequent forward pagination without remounting. Legacy history responses without a watermark use the requested cache watermark to avoid repeated empty fetches. |
| Bot broadcast excludes itself | Existing runtime expansion and Hub dispatch already exclude the author. The Hub regression now also checks the persisted activation record excludes that author. |
| Reply mention avatars | Both composers use the same avatar-bearing candidate component. |
| Per-message activated Bots | The Hub persists `activatedBotPrincipalIds` after dispatch deduplication and causal limits, includes it in the accepted ACK and canonical event, and the UI renders it in the main log and reply chain. This records AI dispatch selection, not started/completed work. Historical events without this field say that dispatch was not recorded; queued messages await confirmation. |
| Candidate owner/contact | Both menus display avatar, Bot name and the actual owner Human's name from the authorized member list. Missing owner data is labeled rather than inferred. |
| Large recipient sets | Messages and both composer previews show at most two Bot chips plus a total-count button. Hover/click opens the complete scrollable vertical list. Escape closes only that list. Verified with twelve Bots, dark theme and a 390-pixel viewport. |
| Mid-message mentions | Candidate lookup follows the mention parser's address boundary, including Chinese text immediately before `@`. Both composers preserve the chosen principal through editing and sending. Email addresses, quotes and code retain literal behavior. |
| Optional automatic admission | Administrator checkbox is off by default. Policy is persisted, version checked and audited. Only future signed joins are automatically approved; existing pending requests retain their decision state. Disabling restores manual approval. Normal key proof, challenge expiry, limits, revoked-key denial, contact authorization and publication scope remain in force. |

## Verification

- Plugin suite: 2,132 cases, 2,127 passed, five existing skips, zero failures.
- Hub suite: 210 cases passed; real HTTP/WebSocket enrollment covers both manual
  and automatic admission followed by signed login and contact authorization.
- Eight actual two-instance DSH + Mock scenarios passed, including explicit/no
  reply, bounded collaboration, reply A plus mention B with quoted context,
  collection, draft recovery, repeated corrective reminders and restart.
  The client history's activation metadata matches the Hub AI deliveries.
- Browser checks cover both mention menus, all three expanded recipient lists,
  dark theme, narrow-screen bounds and no accidental sends.
- Client build freshness and lint checked. No DSH implementation or user data
  was modified; no live model credentials were used.
