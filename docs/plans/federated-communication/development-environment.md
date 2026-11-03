# 跨实例通信：开发环境与本地验证

## 1. 目标与范围

在一台机器上启动两个相互独立的 DSH 实例，模拟两个人各自使用本地 Bot，通过通信服务进行群聊和私聊。
本文先给出 Windows 11 / PowerShell 的完整示例；这是开发路径建议，不是对用户实际操作系统的认定。实施时先确认系统，Linux 可使用后面的 bench 路径。
先验证身份、收发、路由、去重和重连，再补不同 IP 的网络验证。
本文只规定通信开发环境，不引入任务管理、设计审批、执行编排或跨机器工作目录共享。

本文中的现有命令已经按以下源码基线核对；未来新增服务和脚本会明确标注。

| 项目 | 固定基线 |
|---|---|
| 用户 fork | `KarlToon-FFAC/DS-Bot` |
| DS-Bot | `0.2.6`，`5c514ad70d5f3fd1c3b72b2e76e530bef50989d7` |
| DeepSeek Harness | `0.2.1-rc.4` |
| DSH tag / commit | `dsh-v0.2.1-rc.4` / `504a01a9578abc2c6f1fb896b1dc322c9fe24f66` |
| 本次方案分支 | `docs/federated-communication`，从用户 fork 的 `main` 建立 |
| 推荐运行环境 | Windows 11、PowerShell、Node.js 24 |

已有 Node.js 22.19 或更高的 22.x 可以使用；官方 engines 为 `^22.19.0 || >=24.0.0`，不包含 Node.js 23。
本次是用户 fork 的方案工作，不要求取得上游 `dev` 分支权限才能继续。
后续实现前先检查工作树和分支，保留用户已有修改，并从包含本组方案文档的版本创建实现分支。

## 2. 双实例与端口安排

| 组件 | 地址 / 目录 | 用途 |
|---|---|---|
| DSH A | `127.0.0.1:3101` | 人 A 与本地 Bot |
| DSH B | `127.0.0.1:3102` | 人 B 与本地 Bot |
| Mock A | `127.0.0.1:8801` | A 的脚本模型 |
| Mock B | `127.0.0.1:8802` | B 的脚本模型 |
| 通信服务 | 建议 `127.0.0.1:3190` | 待实现的共享通信服务 |
| A 数据 | `D:\dsh-communication-test\a\data` | 独立 `DSH_HOME` |
| B 数据 | `D:\dsh-communication-test\b\data` | 独立 `DSH_HOME` |
| A 工作目录 | `D:\dsh-communication-test\a\workspace` | A 的测试文件 |
| B 工作目录 | `D:\dsh-communication-test\b\workspace` | B 的测试文件 |

两端可以链接同一份插件源码；Bot 数据、会话、凭据和工作目录分别保存。
实例标识应由通信功能生成并持久保存，不能把端口、IP 或进程 PID 当作唯一身份。
换端口、重启进程后，实例身份和消息归属应保持不变。

## 3. 开始前检查

以下示例假定 fork 已下载到 `D:\git\DS-Bot`；实际路径不同就统一替换。
先在 PowerShell 检查工具和版本：

```powershell
node --version
npm.cmd --version
pnpm.cmd --version
git --version
Get-NetTCPConnection -LocalPort 3101,3102,3190,8801,8802 -State Listen -ErrorAction SilentlyContinue
```

端口检查没有输出表示没有查到监听进程；如果端口占用，先识别进程，改用空闲端口或停止本轮启动的对应进程。
不要终止所有 `node.exe`，也不要为了测试停止用户原来运行的 DSH。
`dsh plugin` 会调用 PATH 中的 `pnpm`；缺少 pnpm 时，按已有开发授权安装到合适环境；安装受阻或需选择环境时再询问用户。
仓库开发锁定的 pnpm 版本与运行已发布 CLI 的条件要区分；不要凭空增加 npm 最低版本要求。

## 4. 安装插件开发依赖并检查基线

在插件目录执行现有命令：

```powershell
Set-Location 'D:\git\DS-Bot\ds-bot'
npm.cmd ci
npm.cmd run harness
npm.cmd run build
npm.cmd test
node scripts/build-client.mjs --check
npm.cmd run lint
```

`npm run harness` 安装 `dev/harness/package.json` 中固定的 DSH、jsdom 和 oxlint；该基线固定 DSH 为 `0.2.1-rc.4`。
这不是完整 DSH 源码 checkout，也不自动满足 WSL `dev/bench.sh` 对源码环境的要求。
`client.js` 是生成文件。修改 `src/client/` 后重新构建，不能手工修改生成结果。
基线命令失败时记录命令、版本和错误；先区分既有环境问题与本次修改引起的问题。

## 5. 原生 Windows：启动实例 A

在独立 PowerShell 终端 A 执行。先安装本地插件链接，再启动本地 Mock 和 DSH。
下面的 `mock-key` 是仓库 Mock 协议使用的固定占位值，仅配合回环地址使用，不是任何模型服务的真实凭据。

```powershell
$env:DSH_HOME = 'D:\dsh-communication-test\a\data'
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
New-Item -ItemType Directory -Force -Path 'D:\dsh-communication-test\a\workspace' | Out-Null
Set-Location 'D:\dsh-communication-test\a\workspace'

npx.cmd --yes @deepseek-ai/dsh@0.2.1-rc.4 plugin --profile web add 'link:D:/git/DS-Bot/ds-bot'

$env:MOCK_PORT = '8801'
$env:MOCK_LOG = Join-Path $env:DSH_HOME 'mock.jsonl'
$mockA = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'D:\git\DS-Bot\ds-bot\dev\mock-llm.mjs' -PassThru -NoNewWindow
$mockA | Select-Object Id, StartTime
Start-Sleep -Milliseconds 800
if (-not (Test-NetConnection 127.0.0.1 -Port 8801 -InformationLevel Quiet)) {
    throw 'Mock A 尚未监听 8801；检查 Mock 进程后再启动 DSH。'
}

$env:DEEPSEEK_BASE_URL = 'http://127.0.0.1:8801/v1'
$env:DEEPSEEK_API_KEY = 'mock-key'
npx.cmd --yes @deepseek-ai/dsh@0.2.1-rc.4 web --host 127.0.0.1 --port 3101 --no-open
```

若 Mock 启动较慢，可重新检查端口；不要重复启动已经监听的 Mock。
`$env:DSH_HOME` 只设置当前终端及其后续子进程，不修改 Windows 全局环境变量。

## 6. 原生 Windows：启动实例 B

另开独立 PowerShell 终端 B，使用另一组数据、工作目录和端口：

```powershell
$env:DSH_HOME = 'D:\dsh-communication-test\b\data'
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
New-Item -ItemType Directory -Force -Path 'D:\dsh-communication-test\b\workspace' | Out-Null
Set-Location 'D:\dsh-communication-test\b\workspace'

npx.cmd --yes @deepseek-ai/dsh@0.2.1-rc.4 plugin --profile web add 'link:D:/git/DS-Bot/ds-bot'

$env:MOCK_PORT = '8802'
$env:MOCK_LOG = Join-Path $env:DSH_HOME 'mock.jsonl'
$mockB = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'D:\git\DS-Bot\ds-bot\dev\mock-llm.mjs' -PassThru -NoNewWindow
$mockB | Select-Object Id, StartTime
Start-Sleep -Milliseconds 800
if (-not (Test-NetConnection 127.0.0.1 -Port 8802 -InformationLevel Quiet)) {
    throw 'Mock B 尚未监听 8802；检查 Mock 进程后再启动 DSH。'
}

$env:DEEPSEEK_BASE_URL = 'http://127.0.0.1:8802/v1'
$env:DEEPSEEK_API_KEY = 'mock-key'
npx.cmd --yes @deepseek-ai/dsh@0.2.1-rc.4 web --host 127.0.0.1 --port 3102 --no-open
```

两端首次使用时检查模型路由确实指向各自 Mock；不要在已有真实模型配置上直接套用占位 key。
本地插件链接只需首次安装；重启时保留数据目录，重新设置当前终端所需环境变量即可。
这两组命令启动的是现有 DS-Bot。跨实例通信仍需按实施计划开发，双开本身不代表已实现通信。

## 7. 登录与浏览器隔离

分别打开终端 A、B 打印的带登录 token 的完整地址；首次访问只输入无 token 的根地址可能被拒绝。
不要把启动 token、登录 URL、凭据文件或原始启动日志提交到仓库。
截图和验收记录只保留去掉 token 的地址、实例名称和必要状态。

DSH `0.2.1-rc.4` 的浏览器 Cookie 名称和签名内容包含 hostname 与 port。
因此，同一浏览器打开 `127.0.0.1:3101` 和 `127.0.0.1:3102` 两个标签页可以分别登录。
需要直观区分人 A、人 B 时，可以使用两个浏览器 profile；它不是双实例启动的必要条件。
浏览器登录隔离不能替代通信协议中的人、Bot、实例和群身份校验。

## 8. 当前 Mock 能验证什么

现有 `dev/mock-llm.mjs` 是脚本模型，支持本地建群、`message_bot`、群消息、提及、长回复、延迟和问题卡等流程。
它通过固定输入和输出控制测试，不需要真实模型 API key。
它不具备尚未开发的联邦身份、远程成员工具和重连协议，不能把已有本地 smoke 通过当成联邦验收通过。

实现通信功能时补充确定性 Mock 场景：

- 两端同名 Bot 的目标选择以及远程标记。
- 人发给人、人发给 Bot、Bot 发给人、Bot 发给 Bot 的定向收发。
- 群消息、群中提及、私聊和回复关联分别走正确通道。
- 重发同一消息、断线补发、确认丢失、迟到消息和乱序到达。
- 同时发言时各端最终展示一致，历史重放不再次唤醒 Bot。
- 成员退出、连接撤销、重启后的身份恢复和权限变化。

其中通信协议与持久化测试直接使用假客户端即可；需要验证 Bot 工具与群界面接入时再使用脚本模型。

## 9. 可选 WSL 环境

已有 WSL2 Ubuntu 时，可以使用仓库现有 `dev/bench.sh`；原生 Windows 验证仍要保留。
在 WSL 内使用 Linux 版本的 Node、pnpm 和依赖，不与 Windows 共用 `node_modules`。
准备一个与固定基线匹配的 DSH 源码 checkout，按其官方要求安装依赖并完成构建。
将 `DSH_HARNESS` 指向该源码目录；不要指向插件的 `dev/harness` 依赖目录。

```bash
export DSH_HARNESS=/home/<user>/src/deepseek-harness
cd /home/<user>/src/DS-Bot/ds-bot
npm ci
npm run harness
npm run build
dev/bench.sh peer-a 3101 8801 start
dev/bench.sh peer-b 3102 8802 start
dev/bench.sh peer-a 3101 8801 status
dev/bench.sh peer-b 3102 8802 status
```

把 `<user>` 和 checkout 路径替换成实际路径。DSH 源码基线见第 1 节，依赖与构建方式见官方文档。
bench 将数据保存在 DS-Bot checkout 下的 `.dsh-test-peer-a/` 和 `.dsh-test-peer-b/`，自动配置 Mock。
`reset` 会删除对应 bench 的 Bot 和会话，只在明确需要全新测试数据时使用。
原生实例与 WSL bench 使用了同一组端口；依次运行，或为其中一组重新分配全部端口。

## 10. 待开发的通信服务与启动脚本

以下内容是实施要求，当前仓库不存在相应联邦服务及命令，不能照此宣称已经启动成功。

- 新增独立通信服务，开发默认端口建议为 `3190`，数据存放在专用测试目录。
- A、B 分别主动连接该服务；只开放联邦协议，不通过中转服务暴露 DSH 全部管理接口。
- 新增原生 Windows 启动/停止脚本，记录本轮服务与子进程的 PID、启动时间和测试目录。
- 新增自动化双实例场景脚本，使用 Mock 和专用测试数据，返回明确退出码。
- 新增故障注入能力：只断开指定连接、延迟指定事件、丢弃一次确认或重启指定测试进程。
- 把实际脚本名、参数、日志位置和可复制命令补回本节，再交给用户运行。

不要预先编造 `npm run federation:*`、不存在的配置字段或工具名称。
通信服务身份密钥和连接配置由实现的初始化流程生成；需要用户提供的信息按第 13 节处理。

## 11. 分层验证

| 层级 | 环境 | 要证明的内容 |
|---|---|---|
| 单元与存储 | 假时钟、假连接、临时数据库 | 路由、身份校验、去重、持久化和游标恢复 |
| 本机双实例 | Windows A/B + Mock + 通信服务 | 群/私聊收发、回复关联、远程标记与同步 |
| 本机故障 | 只操作本轮连接和进程 | 断线、确认丢失、重启、补发和历史重放 |
| 不同 IP | 第二台机器或独立虚拟机 | 地址配置、防火墙、连接恢复和真实网络边界 |
| 真实模型 | 用户提供的可用模型配置 | Bot 能正确使用通信工具并理解收件人 |

一台 Windows 足以完成前三级，能验证绝大部分通信逻辑。
本机双开不能替代真实防火墙、NAT、跨网段或不同操作系统的验证。
不同 IP 补测时，DSH 的 `--host` 使用本机具体 IPv4/IPv6 地址；该版本不支持 `0.0.0.0`。
通常只需让两个实例能访问通信服务，不需要把 DSH Web 界面一并暴露到局域网。

## 12. 停止、重启和恢复

原生 Windows 中先在对应 DSH 前台终端按 `Ctrl+C`，等待监听端口释放。
再停止该终端保存的 Mock 进程对象；以下分别在 A、B 终端执行：

```powershell
if ($mockA -and -not $mockA.HasExited) { Stop-Process -Id $mockA.Id }
```

```powershell
if ($mockB -and -not $mockB.HasExited) { Stop-Process -Id $mockB.Id }
```

若原终端已关闭，根据本轮保存的 PID、启动时间、命令行和数据目录核实归属后再停止；仅凭进程名或旧 PID 不够。
通信服务及其后续启动脚本也遵守同样规则。禁止 `taskkill /IM node.exe /F` 等全局终止命令。
WSL 使用现有 bench 的对应停止命令：

```bash
dev/bench.sh peer-a 3101 8801 stop
dev/bench.sh peer-b 3102 8802 stop
```

重连和重启测试保留原数据目录，检查身份、消息和游标恢复；不要用清空数据绕过恢复问题。
只有清洁安装测试才新建或重置专用测试目录，禁止操作用户真实 `~/.dsh`、桌面应用数据或其他测试批次。

## 13. 缺少依赖、配置或 API key 时

本地 AI 先说明缺少什么、影响哪一步、已经完成什么，以及用户需要提供或授权什么。
需要真实模型测试却没有可用 key、模型名或 endpoint 时，直接询问用户；不要猜测、伪造或复制其他实例的凭据。
真实凭据只通过本地安全配置入口录入，不写进代码、方案文档、聊天示例或验收日志。
缺少 npm/pnpm 包、网络访问、代理或证书时，同样说明具体错误并询问，不擅自绕过访问限制。
等待用户期间继续做不依赖该条件的协议、存储、假客户端和 Mock 工作。
阻塞的检查标记为“未执行/待配置”，不能跳过后将整项写为“通过”。

## 14. 环境交付与验收记录

至少记录：代码 commit、Windows/WSL 版本、Node/pnpm/DSH 版本、端口、数据目录和实际运行命令。
每个场景记录输入身份、目标群或私聊、消息 ID、预期结果、实际结果及去除敏感内容的证据。
记录经过持久化接收、展示、调用 Bot 的不同阶段，避免把网络 ACK 当成最终展示成功。
记录未覆盖的不同 IP、真实模型或其他环境，不把环境启动成功当作功能验收成功。
日志、截图和测试记录不包含 token、真实 key、浏览器 Cookie、真实用户私聊或机器上的无关文件。
后续实现达到仓库要求时执行 `npm test`、构建一致性检查和 lint；Host 代码变更还要做独立数据下的 smoke。
新增联邦场景需单独执行并保存结果，现有 smoke 不能替代它们。

## 15. 源码与官方依据

- [DS-Bot 开发约束与验证命令](https://github.com/KarlToon-FFAC/DS-Bot/blob/5c514ad70d5f3fd1c3b72b2e76e530bef50989d7/AGENTS.md)。
- [DS-Bot package scripts](https://github.com/KarlToon-FFAC/DS-Bot/blob/5c514ad70d5f3fd1c3b72b2e76e530bef50989d7/ds-bot/package.json) 与 [测试 harness 固定版本](https://github.com/KarlToon-FFAC/DS-Bot/blob/5c514ad70d5f3fd1c3b72b2e76e530bef50989d7/ds-bot/dev/harness/package.json)。
- [现有 bench](https://github.com/KarlToon-FFAC/DS-Bot/blob/5c514ad70d5f3fd1c3b72b2e76e530bef50989d7/ds-bot/dev/bench.sh) 与 [现有脚本模型](https://github.com/KarlToon-FFAC/DS-Bot/blob/5c514ad70d5f3fd1c3b72b2e76e530bef50989d7/ds-bot/dev/mock-llm.mjs)。
- [DSH 完整 CLI 帮助](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/docs/cli-help.md)：`web --host/--port/--no-open`。
- [DSH CLI 参考](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/apps/cli/reference/README.md)：`DSH_HOME`、插件本地链接、pnpm 与源码构建。
- [DSH Node engines](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/package.json)。
- [DSH Connection](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/client/connection/README.md)：启动 token、按 hostname/port 绑定的 Cookie 与认证。

本文是环境准备与实施说明，不表示已经在用户 Windows 机器上安装依赖、启动实例或通过联邦通信验收。
