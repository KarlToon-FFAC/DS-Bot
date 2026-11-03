# Bounded OpenAI real-model preparation

Status: **PREPARED_MOCK_ONLY / REAL_NOT_RUN**. The user's latest choice is the
official OpenAI API and GPT-6 Luna; this replaces the earlier DeepSeek Flash
proposal. Neither the old $0.10 suggestion nor the limits below authorize spending.
Update: the owner subsequently authorized a temporary official-OpenAI key,
synthetic data, eight requests and a $5 account ceiling. This phase still makes
no API calls; see [private input and the strict-bill limitation](openai-private-input.md).
Account access remains unverified. No credential was read or requested and no
authenticated API, model or token-count request has been made.

## Model and published prices

Verified against official documentation on 2026-11-03:

- The exact API model ID is **`gpt-6-luna`**. It supports Responses and function
  calling. `gpt6luna` is the user's shorthand, not a literal API ID;
  `gpt-5.6-luna` is a different model. No fallback is permitted.
  [Official model page](https://developers.openai.com/api/docs/models/gpt-6-luna).
- Standard prices per million tokens are input **$0.10**, cached input **$0.01**,
  output **$0.50**, cache writes **$0.125 / 30m** and **$0.25 / 12h**.
  [Official pricing](https://developers.openai.com/api/docs/pricing).
- Exact preflight counting uses `POST /v1/responses/input_tokens` with the same
  model-visible input, instructions, tool schemas and reasoning/text settings.
  [Official token-count guide](https://developers.openai.com/api/docs/guides/token-counting).

The locally pinned official OpenAI SDK is 7.19.0. Its static ChatModel union names
`gpt-5.6-luna`, but not the current `gpt-6-luna`; arbitrary model strings are
supported. The installed Pi-AI 1.5.0 catalog has no Luna entry. These stale static
catalogs neither disprove the current documentation nor prove account access.
Use an explicit custom `openai-responses` route/model list through DSH's published
configuration, without modifying DSH or upgrading installed packages.

## Implemented local gates

`ds-bot/dev/communication/openai-budget.mjs` is a development-only exit guard.
It is excluded from the published plugin and ordinary Mock benches. The example
configuration is **disabled** (`execute: false`, money budget zero).

- Bind only to `127.0.0.1`; require a random launch-only local nonce. The DSH
  process receives that nonce, while the real OpenAI key would remain only in
  the dedicated guard process. Never put the real key in DSH's environment.
- Pin the upstream origin to `https://api.openai.com`, exact model and Standard
  tier. Disable redirects, remote response storage and all automatic retries.
  Disallow server-side conversation references, previous response IDs, files,
  images, hosted tools and non-communication function tools.
- Before dispatch, reserve the entire worst-case token/cost allowance and both
  count/generation slots in one SQLite transaction. The ledger stores hashes and
  counters, not prompts or credentials. Reopen the same ledger after interruption;
  do not create another run to reset the budget.
- At most **8 total outbound slots**, including metadata checks, exact counting,
  generation, tool continuations and recovery. Each generation consumes two slots,
  so this permits at most **4 generations**, or **3 after one metadata probe**.
  Retries or failures may exhaust the budget earlier; unused reservations are
  never refunded. It does not authorize eight generations or sixteen requests.
- Each generation must count at most **12,000 input tokens** and is capped at
  **1,024 output tokens**, including reasoning. Count failure or over-limit input
  stops before generation. Unknown dispatch outcomes retain their reservations.
- Reserve input at the highest published Standard cache-write category ($0.25/M)
  and output at $0.50/M, with integer rounding. Each possible generation reserves
  **$0.003512**; four reserve **$0.014048**, three **$0.010536**. The policy also
  supports lower aggregate request/token/money limits. Its $0.10 maximum selectable
  ceiling is an implementation ceiling, not approval or a required budget.

These amounts bound modeled generation-token charges at the verified rates.
They are **not a guarantee of the final account bill**: the consulted docs do not
explicitly establish token-count/metadata pricing, and other account charges or
taxes are outside this local ledger. Prices must be checked again before a later
run; the native real sender rejects dates after the recorded verification day.

## Mock verification and public SDK compatibility

Twelve focused tests cover default refusal, exact model/tier, hidden context and
tool denial, exact-count payload agreement, concurrency, over-limit/count failure,
unknown outcomes, cancellation, durable restarts, cost/token ceilings, redirect
policy, metadata accounting and the authenticated loopback streaming path.

The installed Pi-AI public Responses adapter and its official OpenAI SDK also
passed a separate loopback streaming check through the guard into an in-memory
Mock. It used the exact model ID, communication tool schema, `maxTokens: 1024`,
`cacheRetention: none`, `serviceTier: default`, `transport: sse`, no retries and
the resulting `reasoning.effort: none`. This proves local wire compatibility,
not authenticated OpenAI acceptance. Full plugin regression: **1481 tests,
1479 pass, 2 existing skips**; generated bundle and lint checks pass.

Commands and the machine-readable evidence are linked from the native runbook.
The earlier federation review's 1469-test snapshot remains historical evidence;
the twelve new cases test this preparation, not additional federation behavior.

## Smallest next step and remaining scope

The owner has now authorized the bounded pilot and temporary local key use;
do not request the same authorization again. No need to send a key in chat or
create persistent credentials. Before execution, finish the fixed single-run
test worker and explain the final-bill limit above. Use a fresh isolated DSH_HOME,
explicit unique credential reference, local guard nonce and the same durable
ledger. Do not save a credential, use `.env`/`setx`, inspect the personal DSH
profile or use a third-party proxy. DSH's credential seam resolves the explicit
reference from its launch environment; configure the published retry policy as
`{ mode: normal, maxRetries: 0 }`. Real launch wiring is not enabled in this work.

The first bounded metadata check can establish model visibility only; a subsequent
Responses call is still required to establish inference permission. Stop on
authentication, model, price, budget or wire incompatibility instead of substituting
another model, increasing limits or retrying invisibly.

Use only synthetic participant names/IDs, communication persona and schemas,
authorized synthetic history/tool results, and the isolated working-directory
path. These would be sent directly to OpenAI by both counting and generation.
No user chats, files, memory, secrets or personal Bot instructions are included.
The communication Hub and A/B hosts remain loopback.

Prioritize a synthetic DM acknowledgment, a mentioned passive-group reply, and
an injection attempting to read another synthetic conversation; server-side
read-only/passive authorization tests require no model call. Exercise recovery
after final persistence without regenerating that answer. Function continuations
consume the same remaining slots. The 8-slot pilot cannot promise full coverage
of every model scenario; record incomplete cases and stop at the limit. A further
pilot would need a new explicit budget decision. Real model compliance, real
different-machine networking and real WSS remain **NOT_RUN**.
