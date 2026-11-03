# Historical DeepSeek real-model proposal

Superseded by the user's OpenAI / GPT-6 Luna choice. The current model, prices,
implemented gates and remaining authorization are in
[OpenAI preparation](openai-model-preparation.md). The proposal below was never
executed and its model or budget must not be used for the current test.

Status: NOT_RUN; awaits an explicit credential source and spending authorization.
This is a proposal, not a claim that the limits have already been exercised
against a real provider. The local security review and Mock gates are complete.

## Read-only discovery

The pinned DSH 0.2.1-rc.4 exposes two separate public routes:

- `deepseek-official`: `dsh-llm-deepseek-api-key`, credential reference
  `DEEPSEEK_API_KEY`, official Messages root `https://api.deepseek.com/anthropic`.
- `deepseek-account`: existing account grant via the public account provider;
  no fallback to an API key. Signed-out access requires account sign-in.

Evidence is the installed packages' published README/type contracts and
DS-Bot's `src/host/providers.js`, which uses credential **describe** for status
and never reads a key back. All task profiles use a loopback Mock endpoint and
synthetic mock key. The current execution process has no `DEEPSEEK_API_KEY`
reference present. The user's personal DSH profile, stored grants and browser
account sessions were not inspected; there is no evidence of an already
authorized real connection for this isolated test.

## Proposed execution envelope

Use `deepseek-flash` through the official API with an existing user-provided
test key supplied privately on this computer to the single test process. Do not
paste it in chat, create a new key, write it to a file or copy a user profile.
Account sign-in is an alternative only after approval for its specific isolated
profile and stored grant; do not assume it is free.

Before enabling the real route, implement and Mock-verify a global budget guard:
at most **8 provider requests total**, counting tool continuations, explicit
recovery and any background request. Disable normal automatic retries with the
published `retryPolicy: { mode: normal, maxRetries: 0 }`. Limit each response to
1024 tokens, require a measured input estimate no larger than 12,000 tokens, and
stop on any unexpected route, request, auth error or budget overrun. A crash
must not reset the counter. The ordinary task benches stay Mock-only.

Bootstrap a fresh synthetic roster with Mock first. Use only fake names, random
participant IDs and short synthetic text. Test a Human/Bot DM round trip,
mentioned passive group reply, denied read-only send, denied passive active-send,
an injection asking for an unrelated private synthetic DM, and a bounded
interruption/recovery. Model-level refusal is empirical; service authorization
must remain enforced even if the model follows a malicious instruction.

Data sent to DeepSeek: the isolated communication persona, communication tool
schemas, synthetic member/conversation IDs and messages, the authorized synthetic
history and tool results, and DSH's required isolated working-directory path.
No real chats, memories, files, images, secrets or user Bot instructions are
included. No Search/Fetch, shell, filesystem or third-party proxy tools are used.
The Hub/A/B communication network remains loopback.

## Cost and approval needed

On 2026-11-03 the [official price page](https://api-docs.deepseek.com/quick_start/pricing/)
lists Flash peak rates of $0.30 per million uncached input tokens and $1.20 per
million output tokens. With the proposed 8×12,000 input and 8×1024 output budget,
the arithmetic estimate is **$0.0387 maximum at those rates**, before any tokenizer
estimation discrepancy. No cache or off-peak discount is assumed. Request an
explicit **US$0.10 total spending ceiling**, confirm the chosen credential and
destination, and verify current prices again before execution. This proposal is
not authorization to spend, buy credit or create credentials.

The concrete decision for the owner is whether to authorize that official Flash
test, the 8-request/$0.10 limits and private local use of an existing test key.
If account login is preferred, first identify its exact supported login window
and explain where its grant will persist; the user performs any required login.
