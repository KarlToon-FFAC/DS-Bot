<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DS Bot" width="260">
  </picture>
</p>

# DS Bot

New DS-Bot learning suggestions for its own Skills and project AGENTS.md apply
automatically after validation. Set plugin option `learningAutoApply: false` to
keep manual review. Existing pending cards and other tool approvals are unchanged.
See [learning policy and limits](docs/plans/learning-auto-apply.md).

Remote communication in this branch provides authenticated contacts, private
chats and groups between independently paired instances. The toolbar's + opens
private/group pickers; personal settings contains pairing and profile controls.
Each instance connects to one Hub at a time and retains separate Hub history and
queues when switching. Signed Hub codes can carry private-CA trust without
changing system trust. Images/files support at most four attachments and 64 KiB
total per message. See the [Hub guide](communication-hub/README.md) and packaged
[operator/Bot Skill](ds-bot/skills/dsbot-remote/SKILL.md) for permissions, setup,
CLI commands, compatibility and recovery limits.

V0.3.0 adds **Settings → General → Enable remote Hub**. It defaults off on a
new install; an existing joined/configured Hub stays enabled unless explicitly
disabled. The Remote communication entry appears only while enabled. Disabling
requires confirmation and hides all this device's published Bots on the selected
Hub, permanently retiring their remote identities and group memberships. Local
Bots and history stay intact. Offline withdrawal retries in the background;
re-enabling requires explicitly publishing Bots with fresh identities.

Local Bots can help their owner inspect and manage Remote contacts and publish
selected Bots from their own local chat, even before they are published. The host
checks a direct local-user request; Remote messages cannot grant this authority.
Contact changes and publication additionally require native approval for the exact action.
Publication still determines whether a Bot can participate under its own Remote
identity. Local Bot roles and all Hub membership/permission checks stay unchanged.

English | [中文](README.zh.md)

Remote groups can select **multiple default receiving Bots** from the group sidebar. Use **Choose receiving Bots**, confirm the multi-selection to apply it immediately. Member roles and speaking permissions also apply on change; the sidebar scrolls independently on small screens and shows save status with retry on failure. Unmentioned user messages go to every selected Bot; explicit mentions/replies keep their targets, and Bot answers do not activate the default list. Multiple defaults require an updated Hub.

In **V0.3.8**, Remote turns use the same Bot identity and local team, memory, native and attached MCP tool permissions as its local chat. `read_own_chat({"message_id":"…"})` retrieves an exact local message across conversation parts. Local Main Bot, private-Bot, sandbox and approval checks still apply. Local cards and scheduled tasks target the Bot’s local chat; remote publication always requires an explicit communication send.

In **V0.4.0**, local and remote Sessions use one capability toolset: `list_capabilities`, `read_capability`, `save_capability`, `attach_capability`, `detach_capability` and `delete_capability`. Local unpublished Bots need no Hub connection to maintain Skills. Old Skill tool names remain callable compatibility aliases but are no longer advertised to the model. Memory already uses the same `recall`/`remember`/`forget` implementation. Evidence-linked remote relationships and membership-scoped history keep separate tools; filesystem Skills and AGENTS.md remain under the native file/Skill tools.

A local Bot-triggered turn can call `publish_turn_to_user({})` before writing a report to the local user. After the marker is saved, subsequent ordinary text in that turn appears in the user chat and canonical mirror feed. Earlier text, reasoning and later turns remain unchanged. Remote turns and remotely sourced local consultations cannot use this marker; existing internal replies still reach the requesting Bot.

V0.4.0 also selectively backports upstream Bot-pair message persistence, retained work answers and running-turn recovery after reload. Federation routing and consultation receipts are preserved; DSH stays at 0.2.1-rc.4. This does not fix upstream IM multi-chat routing or add an external delivery acknowledgment. See the [migration, risks and source commits](docs/plans/federated-communication/v040-upstream-message-reliability.md).

In **V0.3.9**, accepted contact requests disappear from the request list. Local consultation answers return durable receipts via `reply_to_local_consultation` or `message_bot`; unpublished responders need no Hub publication. Pending consultations can pause the remote turn, and late results notify the original remote Session without automatically publishing them.

![version](https://img.shields.io/badge/version-V0.4.0-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE) ![license](https://img.shields.io/badge/license-Apache_2.0-green)

DS Bot is a bot plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It turns DSH into bots. You create your own bots, then talk and work with them.

![Say one sentence to Chief, and it sets up the bots and the group chat](docs/images/team.png)

A published Bot uses the same own memory and Skills locally and remotely. Remote
turns can update own memory with `remember`/`forget`, edit attached or self-created
Skills with `save_capability` (`kind: "skill", attach: true`) under the existing local permissions, and edit workspace
`AGENTS.md` using native file tools. Use `read_own_chat`, `read_group_chat` and
`read_own_remote_history` for deliberate internal recall. `list_local_bots` and
`consult_local_bot` can reach unpublished local teammates and return an internal
answer; poll the same consultation ID while pending. External publication still
requires an explicit reply tool.

Right-click messages, conversation rows, contacts and group members for contextual
actions. Text editing and selected text retain the native browser menu. The Hub
device list shows each client's reported release version, including the last
reported version while offline; an older client that reports none stays unknown.

## Install

**Desktop app (Windows, macOS, Linux)**

The desktop app brings its own DSH, so you don't need to install DSH first. Download it from [Releases](https://github.com/Fei2411/DS-Bot/releases):

- Windows (x64): `DS-Bot-<version>-win-x64.exe`. Run it; it installs for your user only, without administrator rights. If Windows shows "Windows protected your PC", select **More info** → **Run anyway**.
- macOS: `DS-Bot-<version>-mac-arm64.zip` for an Apple chip, `DS-Bot-<version>-mac-x64.zip` for Intel. Safari unzips it by itself; drag **DS Bot** into **Applications** and open it. When macOS says it cannot check the app, open **System Settings** → **Privacy & Security** and select **Open Anyway**.
- Linux (x64): `DS-Bot-<version>-linux-x86_64.AppImage` runs on every distribution — make it executable and open it. It mounts through FUSE 2, which you may need to install first (`sudo apt install libfuse2t64` on Ubuntu 24.04+, `sudo dnf install fuse-libs` on Fedora, `sudo pacman -S fuse2` on Arch). On Ubuntu 24.04 and later an AppImage can refuse to start (Ubuntu restricts the sandbox it needs); the `DS-Bot-<version>-linux-amd64.deb` on Debian/Ubuntu does not have this problem and adds a menu entry.

At the first start the app asks where to keep its data and the Bots' files, and offers to copy a Bot team from your DSH (it only reads your DSH). Set up a model in its settings. The Windows app and the Linux AppImage update themselves; the macOS app and the Linux deb tell you when a new version is ready to download.

**Desktop app from source (Windows)**

With Node.js 22.19 or later and npm installed, run `.\start.ps1` in PowerShell from this checkout. It prepares and launches the current source, keeping your Bots, chats and model settings in `.ds-bot-local/` between runs. See [source startup](app/README.md#run-from-source-windows).

**As a plugin in DSH**

First install DSH and set up at least one model in it. DS Bot uses the models from DSH.

**DSH Desktop (Windows, macOS)**

1. In the sidebar, select **Plugins** → **Add plugin**.
2. In **Package name or address**, enter `ds-bot`. In mainland China, set **Registry** to **Mainland China mirror**.
3. Select **Install**, then **Enable now**. If DSH says the change takes effect at the next start, quit DSH completely and open it again.

If npm is not reachable, in step 2 you can also enter the full path of `ds-bot-0.2.1.tgz` downloaded from [Releases](https://github.com/Fei2411/DS-Bot/releases), or `github:Fei2411/DS-Bot#v0.2.1&path:/ds-bot` (needs Git).

DS Bot 0.2.1 and earlier cannot update themselves in DSH Desktop 0.2.1-rc.2 or later: on the Plugins page, remove `ds-bot` and add `ds-bot` again. The Bots, chats and memory stay.

**DSH Web (Windows, macOS, Linux)**

Needs Node.js `22.19` or later, and pnpm.

```sh
npx @deepseek-ai/dsh@0.2.1-rc.4 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.1-rc.4 web
```

**Docker (NAS, Linux server)**

The [`docker/`](docker/) directory builds an image with DSH Web and DS Bot, for a NAS or any always-on machine. CI is configured to publish a prebuilt linux/amd64 image to GHCR. The container is the Bots' sandbox: they get full access to what you mount into it, and nothing else. See [`docker/README.md`](docker/README.md).

## Setup

I strongly recommend that you set up your other bots and group chats by just talking to a bot.

### Web search

DS Bot selects its `auto` search provider for the whole profile. If you disable `web-search-auto`, also select another registered search provider in that profile. See [Web search](ds-bot/README.md#web-search) and the [recovery steps](docs/known-issues.md#web-search-fails-everywhere-after-turning-off-web-search-auto).

## Features

### Bot

You can do all your talking and work with one bot, in one window. You don't need to worry about the context behind it. The bot's details page shows its info, and there you can pick the model you want it to use. You can switch models at any time, but I still recommend that you keep one model for a bot for a long time, and switch only when you really need to.

Bots also have memory. A bot remembers what you like and uses it in later work. You can manage its memory on the bot's details page, or just tell the bot.

![Bot details: model, memory, usage](docs/images/details.png)

### Main bot

The main bot is your chief. It has very high rights: it manages the other bots and the group chats. The first time you open DS Bot, there is already a main bot called Chief. Talk to it, and it walks you through the setup.

In short: have a question? Ask the main bot.

### Group chats

DS Bot has group chats. A group chat is a great way to get several bots to work together, but it clearly costs more. So DS Bot does this: every group chat has an admin. The admin answers your messages by default and calls in the other bots for you. You can also @ a bot directly, and it answers you directly: type @ and pick the bot from the list. To give the bots another chat as context, use + → Reference a chat in the message box.

Any bot can hand work to another bot with @. That bot does the work on its own, and the group goes on. While it works, it keeps the group posted, and the group, the sidebar and its own chat show what it is doing. When it is done, it posts the result in the group, and the bot that asked for the work answers. To stop the work, open the group's details.

A group chat has its own memory. What you tell the group stays in the group: its members use it there, and your other chats and the bots outside the group do not see it. You can manage it in the group's details.

![Group chat: the admin, Chief, hands the work to Writer and Coder](docs/images/group.png)

### Capabilities

Settings → **Capabilities** is a shared library of MCP servers, skills and packs. Add a capability to a Bot in its settings; it is available from that Bot's next message in its own chat and group chats. A local MCP command that a Bot adds needs your approval before it can run. While other Bots use a capability, only you or a Main Bot can change or delete it.

### Usage

In **Settings** → **Usage**, you can see token usage by time, by bot and by model.

![Usage page](docs/images/usage.png)

### Office files

Bots work with Office documents. They can create and edit .docx, .pptx and .xlsx, read a document's structure with stable ids, check a package for the defects Office would refuse, make targeted edits (comments, tracked changes, fields, table cells), reorder or duplicate slides, list workbook errors, and review rendered pages on a contact sheet. The desktop app includes everything needed; in DSH Desktop Bots use DSH's Office runtime plus DS Bot's commands; in DSH Web the inspect, check and edit commands work, while creating files from scratch and rendering pages need the desktop app or DSH Desktop.

## Data

All data stays on your own computer, in `bot/` and `sessions/` in the DSH home folder (`~/.dsh` by default). Uninstalling the plugin does not delete this data.

## Development

The plugin source is in [`ds-bot/`](ds-bot/). For options and internals, see [`ds-bot/README.md`](ds-bot/README.md). For development, tests and how the team works, see [CONTRIBUTING.md](CONTRIBUTING.md). For changes between versions, see [CHANGELOG.md](CHANGELOG.md).

## Acknowledgments

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): DS Bot is built on the DSH plugin system. Every bot works in DSH sessions and uses the DSH tools and models.
- [esbuild](https://esbuild.github.io/): bundles the plugin's interface code.
- Thanks to these projects for the ideas they published. DS Bot learned from their designs and does not contain their code:
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo): the Markdown format of Bot memory.
  - [OpenAI Codex](https://github.com/openai/codex): checkpoints that keep the user's messages next to the summary, and message anchors for chat search.
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot): group chat rounds and @mention relays.
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode): one session per member per group chat, and handoffs that carry the earlier user messages.
  - [OpenCode](https://github.com/sst/opencode), [goose](https://github.com/block/goose), [pi](https://github.com/badlogic/pi-mono) and [Gemini CLI](https://github.com/google-gemini/gemini-cli): when to condense a long chat, and what a handoff note holds.
  - [obelisk](https://github.com/tommy0103/obelisk): chat search with a SQLite full-text index.
- Everyone who tries DS Bot, asks questions and reports bugs.

## License

[Apache License 2.0](LICENSE). Provided "as is", without any warranty. Third-party code and its license are listed in [NOTICE](NOTICE).

## Disclaimer

DS Bot is an independent community project. **It is not an official DeepSeek product**, and it is not affiliated with, endorsed by or sponsored by DeepSeek. "DeepSeek", "DeepSeek Harness" and the other names are trademarks of their owners. They are used here only to say what this plugin works with.

Bots use your own model quota, and they read and write files and run commands when you ask them to. Check important actions yourself.


## Remote communication diagnostics

In a local Bot chat, `communication_diagnose` explains connection, the executing Bot’s publication, scoped tools, synchronization, TLS and credential/environment presence without exposing values. Operators can use the authenticated `dsbot-remote diagnose`. See the bundled dsbot-remote Skill, “Diagnostics and first message”. A configuration reload differs from a host process restart; unobserved state stays unknown.
