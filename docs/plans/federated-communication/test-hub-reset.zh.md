# 测试 Hub 清零重建指南

目标：在下一次代码更新后，由操作者或其本地 Agent 清理已经错乱的测试通信数据，重新建 Hub、配对、联系人和群。本文只提供步骤，编写本文时没有操作真实 Hub 或客户端数据。

## 适用版本与边界

- 按提交 `d61b42a9d369b097143ad9b767847d8662439bf7` 的实际实现核查。Hub 为 Node 24+ 服务；Hub SQLite `user_version=4`，客户端通信队列 `user_version=5`，SDK 配对记录版本最高为 3。后续版本执行前先复核下列源码，不要手改版本号。
- 本次是测试数据清零，不是日常断线修复。不要把删库、换身份、降低 `pairingRevision` 当作重连办法。
- 只操作明确核实过的测试实例。不要按本文猜测路径，不要操作用户自己的 `~/.dsh`、其他 Hub 或未授权的安装版数据。
- Hub 与所有客户端使用同一兼容代码版本；升级不能只更新仓库而继续运行 `app/node_modules/ds-bot` 的旧副本。
- **先停止使用和自动发送；涉及移动、删除、备份文件前，先完整停止对应 Hub/客户端进程。** 路线 A 先保留旧 Hub 在线完成受控注销，随后才停服务和动文件。

## 1. 先选清零范围

| 范围 | 清零后结果 | 仍然保留 |
| --- | --- | --- |
| Hub 数据库及其 WAL/SHM | Hub ID、已审批设备、公钥授权、用户码、联系人/申请、群/成员/权限、消息/内联附件、事件、投递/回执、游标、操作去重、头像/昵称、管理审计及库内曾保存的密码校验记录全部清零重建 | Hub 配置文件、环境变量来源、TLS 证书/私钥、公开 CA 文件、客户端自己的所有文件 |
| 某客户端的 `forget-hub`，选择删除本地历史 | 该 Hub 的 SDK 配对私钥/信任记录、选中配置、远程队列/收发箱/游标/投递映射/本地关系记忆被删除 | 其他 Hub、本地 Bot、普通本地群、普通本地消息、DSH Session 日志、普通 Bot 记忆、工作区、模型配置/密钥；浏览器未发送内容也不在这个删除范围 |
| 全新客户端数据根和 shell 根 | 活跃测试客户端从空白开始，没有旧配对、队列、Bot、Session、模型配置、浏览器未发送内容或登录 | 旧目录和外部工作区仍在磁盘，除非另外删除；Hub 也不会随客户端重建 |

**路线 A**：旧 Hub 还能正常管理和认证，使用 Hub code / SDK 登记配对，保留本地 Bot/模型配置，只清远程通信。旧静态 `credentialEnv` 配对没有这套 SDK 注销记录，本次从零测试应走路线 B，不能套用 `forget-hub`。

**路线 B**：旧 Hub 无法完成注销，或确实愿意连本地 Bot/会话一起重来，使用全新客户端数据根。不要在坏状态上伪造注销标志。

删除服务器库而保留客户端原队列并重新连接，不算完成清零。旧 outbox、成员 epoch、消息映射和游标不能带进新身份。反过来，只清客户端也不会删除 Hub 的服务器历史。

## 2. 核实真实路径，留一份非秘密清单

记录代码提交、Hub 启动方式、配置绝对路径、数据库绝对路径、旧 Hub ID、每台客户端数据根、插件 `home`、shell 根和选择的路线。不要记录密钥、密码、cookie、完整凭据文件或其内容。

### Hub

查看**实际启动命令**使用的配置。`databasePath` 相对于该配置文件所在目录解析，不相对于当前终端或仓库。两个示例不同：

- `communication-hub/managed.config.example.json` 指向该示例目录下的 `data/hub.sqlite`。
- 将同一示例复制成 `.ds-bot-local/hub/config.json` 后，指向 `.ds-bot-local/hub/data/hub.sqlite`。
- 静态示例 `config.example.json` 指向 `../.dsh-test-hub/hub.sqlite`。不能据此断定现用库的位置。

不要打印整个配置。下文脚本只读取并解析 `databasePath`。若部署没有用仓库 CLI，而是嵌入式 `startHub()`，以实际传入的 `databasePath` 为准，不能套用配置脚本。

### 客户端

- `start.ps1 -DataRoot <R>`：`DSH_HOME=<R>/data`，workspace 为 `<R>/workspace`，shell 为 `<R>/shell`。默认 `<R>` 是仓库内 `.ds-bot-local`，不是安装版数据。
- 安装版：用 Settings → General → Locations 和实际启动环境核对。`DS_BOT_HOME` 可覆盖数据位置，`DS_BOT_SHELL_DATA` 可覆盖 shell 位置；旧版安装可能继续用 `DeepSeek Bot` shell 目录。不要凭 `%APPDATA%` 或 Linux 常见路径猜。
- 插件数据为 `config.home`；未指定时是 `<DSH_HOME>/bot`。本地 Agent 必须核对当前选中 profile 的 `id: bot` 配置及覆盖层。
- 旧通信库为 `<插件 home>/communication.sqlite`；新命名空间库为 `<插件 home>/communication-hubs/<scope>/communication.sqlite`。`scope` 可能由 Hub ID 及设备公钥共同决定，不能只按服务器地址猜。
- 配对密钥由 DSH SDK 凭据 provider 管理，记录名为 `ds-bot/communication-<Hub ID 的 SHA-256 前 32 位>`。它不是普通 `bot/secrets.json`；**不要为清一个 Hub 删除整个 `.credentials.yaml`**，其中还可能有模型等其他凭据。自定义 provider 的物理路径不由本文断言。
- 先通过已认证的本地 `onboarding-storage` 列出保存的 Hub 和选中项。该接口只返回状态元信息，不应读取或输出原始密钥。

## 3A. 路线 A：先注销旧配对，再停服务

此阶段旧 Hub 仍在线，客户端只为注销操作运行，不再发测试消息。停止 Bot 正在进行的远程任务，不提交未发送未发送内容。

1. Hub 管理员在旧 Hub `/admin/` 核对设备列表，逐一 **Revoke** 这次要清理的测试设备。这样不用先转移旧群所有权。`revoke` 会失效设备认证和活动群成员，但此时仍保留服务器历史。
2. 每台客户端在连接设置中对**准确的旧 Hub**执行 **Check revoked access**，对应本地 Human CLI `hub-leave-status`。只有签名状态确认 `left:true` 后再忘记。单纯离线、显示错误或断开连接都不等于服务端已撤销。
3. 执行 **Forget this Hub**，勾选删除本地历史。等价 CLI 请求如下。`OLD_HUB_ID` 和 `OLD_HUB_URL` 换成已核对的值；CLI 的本地认证按现有私密方式提供，不把 cookie 放 argv 或文件。Windows 用 `node.exe`，Linux 用 `node`，均从仓库根目录运行。

```powershell
'{"hubId":"OLD_HUB_ID","confirmedUrl":"OLD_HUB_URL"}' | node.exe ds-bot/bin/dsbot-remote.mjs hub-leave-status
'{"hubId":"OLD_HUB_ID","confirmedUrl":"OLD_HUB_URL","confirmForget":true,"deleteLocalHistory":true,"confirmDeleteLocalHistory":true}' | node.exe ds-bot/bin/dsbot-remote.mjs forget-hub
```

```bash
printf '%s\n' '{"hubId":"OLD_HUB_ID","confirmedUrl":"OLD_HUB_URL"}' | node ds-bot/bin/dsbot-remote.mjs hub-leave-status
printf '%s\n' '{"hubId":"OLD_HUB_ID","confirmedUrl":"OLD_HUB_URL","confirmForget":true,"deleteLocalHistory":true,"confirmDeleteLocalHistory":true}' | node ds-bot/bin/dsbot-remote.mjs forget-hub
```

4. 有尚未审批的申请时先 `cancel-hub-join`，观察已取消状态，再忘记。`HUB_LEAVE_REQUIRED`、`HUB_CANCEL_REQUIRED`、`COMMUNICATION_PAIRING_CONFLICT`、文件权限或 Config Editor 错误出现时停止处理该设备，不手改记录、复制身份或绕过验证。旧 Hub 已不可用且无法证实撤销时改走路线 B。
5. `forget-hub` 返回应有 `forgotten:true`、`historyRetained:false`。复查 `onboarding-storage`：目标 Hub 不再保存，其他 Hub 未变。该操作已自行关闭目标队列后删除相应库/WAL/SHM或作用域目录。不要再笼统删除整个 `communication-hubs/`。
6. 在每个实际使用过的客户端浏览器 origin 中，仅删除 `sessionStorage`/`localStorage` 里属于旧 Hub 的 `ds-bot:communication:` 未发送内容、待确认操作、隐藏项及 thread intent。可在 DevTools 的 Application/Storage 面板核对 key/value，勿打印正文。若此 profile 只用于此次测试，可以删除该前缀的所有项；共享 profile 需按旧 `instanceId` / Hub scope 定位，不能清其他 Hub。旧待发 intent 不应手动重新提交。不要清整站数据来代替，否则还会丢登录和其他设置。
7. 完整退出每台 DS Bot，包含托盘；关闭同数据根的 DSH Web/Desktop及其 Host。然后按第 4 节停止并重建 Hub。

路线 A **不会清掉**包含旧远程内容的 DSH Session 日志或已经写入普通 Bot 记忆的内容。没有经过核实的按远程绑定安全删除所有 Session 的统一命令。若要求连这些残留也完全隔离，走路线 B；不要直接删除整个 `sessions/` 后仍声称保留普通本地聊天。

## 3B. 路线 B：所有客户端使用全新空目录

1. 先完整退出旧客户端及 Host，包括托盘和同数据根的其他 DSH。保持它们关闭，不再让旧启动项、服务、快捷方式或其他电脑自动重连。
2. 将旧测试客户端根、其独立 shell 根及实际插件 `home` 纳入可选备份。新目录与旧目录互不包含，并且不在用户自己的 DSH、现用 Hub 数据目录或要保留的工作区内。不要复制旧 `bot/`、`sessions/`、profile 或凭据库到新根。
3. 完成第 4 节 Hub 清零后再启动新客户端。每台电脑使用自己的空目录，不从别的电脑克隆。

Windows 源码启动器，从仓库根目录：

```powershell
$NewRoot = Join-Path (Get-Location) '.ds-bot-local/reset-device-a'
if (Test-Path -LiteralPath $NewRoot) { throw '目标必须是未使用的新目录；换一个名字。' }
.\start.ps1 -DataRoot $NewRoot
```

Linux 源码启动，在已按 [app/README.md](../../../app/README.md) 准备依赖和 Linux runtime 后：

```bash
REPO="$(pwd -P)" # 当前必须是仓库根目录
NEW_ROOT="$REPO/.ds-bot-local/reset-device-a"
test ! -e "$NEW_ROOT" || { printf '%s\n' '目标已存在；换一个未使用的目录。' >&2; exit 1; }
mkdir -p "$NEW_ROOT/data" "$NEW_ROOT/workspace" "$NEW_ROOT/shell"
(
  export DS_BOT_HOME="$NEW_ROOT/data"
  export DS_BOT_WORKSPACE="$NEW_ROOT/workspace"
  export DS_BOT_SHELL_DATA="$NEW_ROOT/shell"
  unset ELECTRON_RUN_AS_NODE
  cd "$REPO/app"
  npm start
)
```

显式 `DS_BOT_HOME` 不会从用户自己的 DSH 导入旧团队。新数据根需要重新配置模型、创建 Bot；shell 根也隔离未发送内容、cookies 和浏览器登录。普通安装版可以在私密启动环境设置上述三项后启动准确的现有应用可执行文件，具体安装路径需本机核对，不由本文猜测。

旧目录保留属于隔离，不是物理擦除。验证新环境后，若不需要备份，操作者可删除**已核对的旧测试根/独立 shell 根**，绝不删除用户自己的 `~/.dsh`、共享工作区或整个仓库。外置 `config.home`、独立文件和其他机器副本需要单独核对。普通文件删除也不保证介质级不可恢复。

## 4. 停 Hub、可选备份、清掉准确的 SQLite 文件

1. 关闭所有客户端后，在实际 Hub 终端按 **Ctrl+C** 等正常退出。CLI 同时处理 SIGINT/SIGTERM。Linux 后台进程可对核实过的 Hub PID 发 `kill -TERM <PID>` 并等待退出；若是自建 systemd/Windows 服务，由原服务管理器停止准确服务并停用其自动拉起。本仓库不会自动安装服务，服务名不能猜。
2. 核实 Hub 进程确实结束、原端口不再由它监听；不能只因 `/health` 超时就判定已经停止。不要 `taskkill /IM node.exe` 或 `killall node` 杀其他程序。
3. 可选备份：停机后复制现用 Hub 配置、库及仍存在的 `-wal` / `-shm`，以及要回滚的各客户端完整数据根和 shell 根；外置 `config.home` 也需覆盖。TLS 私钥、凭据、`.env` 和密码来源只通过现有安全机制保管，不输出到日志或提交仓库。活动库不能只复制主 `.sqlite` 后宣称备份完整。
4. 下面脚本默认把准确的三个文件移到同目录下的时间戳隔离文件夹，便于回滚。确实不留旧数据可把 `KeepBackup` 改为 false；**删除分支不可撤销**。不删除 Hub 整个数据父目录，不动配置、证书/私钥、CA或其他库。

Windows PowerShell，先填实际配置绝对路径：

```powershell
$ErrorActionPreference = 'Stop'
$HubConfig = (Resolve-Path -LiteralPath 'D:\REPLACE\actual-hub-config.json').Path
$HubDb = & node.exe -e "const f=require('node:fs'),p=require('node:path'),c=p.resolve(process.argv[1]),v=JSON.parse(f.readFileSync(c,'utf8')).databasePath;if(typeof v!=='string'||!v||v===':memory:')process.exit(2);process.stdout.write(p.resolve(p.dirname(c),v))" $HubConfig
if ($LASTEXITCODE -ne 0 -or -not $HubDb) { throw '无法核实 Hub 数据库路径。' }
$KeepBackup = $true
$Archive = Join-Path (Split-Path -Parent $HubDb) ('reset-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$Targets = @($HubDb, ($HubDb + '-wal'), ($HubDb + '-shm'))
$Targets # 人工核对三个绝对路径；确认进程已退出后才继续下面几行
if ($KeepBackup) { New-Item -ItemType Directory -Path $Archive -ErrorAction Stop | Out-Null }
foreach ($Path in $Targets) {
    if (Test-Path -LiteralPath $Path) {
        $Item = Get-Item -LiteralPath $Path -Force
        if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '拒绝目录或链接。' }
        if ($KeepBackup) { Move-Item -LiteralPath $Path -Destination $Archive -ErrorAction Stop }
        else { Remove-Item -LiteralPath $Path -ErrorAction Stop }
    }
}
```

Linux Bash，先填实际配置绝对路径：

```bash
set -euo pipefail
HUB_CONFIG='/REPLACE/actual-hub-config.json'
HUB_DB="$(node -e 'const f=require("node:fs"),p=require("node:path"),c=p.resolve(process.argv[1]),v=JSON.parse(f.readFileSync(c,"utf8")).databasePath;if(typeof v!=="string"||!v||v===":memory:")process.exit(2);process.stdout.write(p.resolve(p.dirname(c),v))' "$HUB_CONFIG")"
test -n "$HUB_DB"
KEEP_BACKUP=true
ARCHIVE="$(dirname "$HUB_DB")/reset-backup-$(date -u +%Y%m%dT%H%M%S)-$$"
printf '%s\n' "$HUB_DB" "$HUB_DB-wal" "$HUB_DB-shm"
# 人工核对三个绝对路径；确认进程已退出后才继续下面几行
if "$KEEP_BACKUP"; then mkdir -- "$ARCHIVE"; fi
for path in "$HUB_DB" "$HUB_DB-wal" "$HUB_DB-shm"; do
  if test -e "$path" || test -L "$path"; then
    test ! -L "$path" && test -f "$path" || { printf '%s\n' '拒绝非普通文件或链接。' >&2; exit 1; }
    if "$KEEP_BACKUP"; then mv -- "$path" "$ARCHIVE/"; else rm -- "$path"; fi
  fi
done
```

脚本不能替你证明服务已停或父目录无链接。执行者应先核对真实路径和部署，遇到权限/链接/路径不符或移动中断立即停下，清点三个文件，不盲目重跑或启动。不要把隔离备份放进 Git。

## 5. 重建顺序

1. 更新 Hub 和所有客户端到同一兼容版本，刷新 app 的插件副本：在 `ds-bot/` 按仓库说明安装依赖并 `npm run build`，再在 `app/` 运行 `npm ci`。Windows `start.ps1` 已包含构建和副本刷新。不要在旧 app 还运行时更新其依赖。
2. 保留实际地址、端口、TLS 和 CA 配置，确定新 Hub 使用 `management.enabled:true`。全新库没有旧密码校验记录，必须通过配置指定的 `management.adminPasswordEnv` 私密注入至少 16 字符管理员密码；仅依赖旧库里密码记录会启动失败。TLS 私钥和静态 peer 凭据也要通过其原环境引用提供，不能写进命令参数或本文。
3. 使用已核实的配置重新启动。Windows：`npm.cmd --prefix communication-hub start -- "$HubConfig"`；Linux：`npm --prefix communication-hub start -- "$HUB_CONFIG"`。均从仓库根目录运行。
4. 现用配置中的 `peers` 会在新库中重新授权静态设备。若目标是全部设备重新审批，启动前由操作者明确移除旧静态 `peers`（保留其他配置，管理模式下可为 `[]`）。仍保留静态模式时，只配置明确保留的新实例与独立凭据，不让旧自动启动项接入新库。
5. 新库启动自动生成**新的 Hub ID**。登录打印的真实 `/admin/` 地址获取新 Hub code。旧 code/已保存的 Hub ID 已失效，即使 URL、证书和密码不变。不要手改新库把旧 Hub ID 填回来。
6. 路线 A 打开已忘记旧 Hub 的原客户端；路线 B 打开新数据根客户端。逐台粘贴新码、核对 URL/Hub ID/CA 指纹、提交申请；管理员核对申请人和公钥指纹后审批。每台是独立新设备身份，不能复制配对记录。
7. 明确重新选择发布的本地 Bots。新 Human 获得新用户码，双方重新申请/接受联系人并选择各自共享 Bot 范围（默认空）。重新建群、发邀请、接受、配置管理员和发言权限。旧群所有权/成员/权限不会自动继承。
8. 重配完成后更新测试启动脚本/快捷方式使用的新配置/数据根；旧根保持停止。记录新的非秘密 Hub ID 和各机实例 ID。

## 6. 验收与失败处理

- `/health` 成功只说明 HTTP 服务就绪，不证明配对、联系人或消息同步。
- 所有客户端 `onboarding-storage` / `state` 指向新 Hub，显示已审批且连接正常；没有借用其他客户端实例 ID。路线 A 其他 Hub 和本地 Bot 应仍在。
- 新 Hub 初始不应有旧设备申请、联系人、群、消息；静态 `peers` 重建条目及新配对/注册生成的记录属于预期。新环境不出现旧待发消息或旧群。
- 两个新 Human 互发带唯一测试标记的消息，确认接收；分别测所选 Bot 的 DM 和新群。先用无模型或 mock 能验证的路径，真实模型调用按原有授权和费用约束处理。
- 正常重启 Hub/客户端一次，再短暂断线恢复，确认消息不重发、不串群，联系人/群/游标和新身份仍在。新一条测试消息仍可送达。清零不是连接缺陷已经修复的证据，异常时保留脱敏错误和消息 ID。
- 不要把旧 outbox、旧数据库、旧 Session 绑定或旧凭据导回新环境。认证、TLS、网络、版本错误分别处理，不关闭 TLS 验证或绕过撤销。
- 不确定的 CLI 写操作先读状态再决定，退出码 5 不等于确定失败，不重新生成 ID 反复提交。

## 7. 回滚

有完整停机快照时：停止新 Hub 和全部客户端，隔离新数据；恢复**同一快照配套的 Hub 库三件套、Hub 配置、各客户端数据根/插件 home/shell 根，以及匹配的旧二进制与秘密来源**。恢复时先确认目标位置没有新运行遗留的 WAL/SHM，不能把旧主库叠到新 sidecar 上。恢复 Hub 后再启动对应旧客户端，检查 Hub ID、身份和数据一致。

路线 A 的备份若在 revoke/forget **之后**才做，不包含撤销前状态。想回到重置前，备份必须在这些操作之前，并在停止所有写入后形成一致快照；可先全部停机备份，再仅为第 3A 节启动旧服务。不同机器时点不一致或缺少密钥/provider快照时，不能保证恢复。

没有备份或快照不完整时，不承诺恢复。重置后新发的消息不会自动合并回旧库；选择回滚意味着另行保留或放弃新测试记录。不要降 `user_version`、手改游标/epoch/撤销位或混合两套库。

## 源码核对点

- [Hub CLI：路径解析和退出](../../../communication-hub/src/cli.js)
- [Hub canonical 数据、schema 与身份](../../../communication-hub/src/store.js)
- [Hub 管理数据、随机 Hub ID、撤销](../../../communication-hub/src/management-store.js)
- [管理密码与内存会话](../../../communication-hub/src/management-http.js)
- [客户端 SDK 记录、queue scope、forget 边界](../../../ds-bot/src/host/federation/onboarding.js)
- [客户端队列、Session 绑定和关系记忆](../../../ds-bot/src/host/federation/queue-store.js)
- [Human CLI JSON 和生命周期](../../../ds-bot/bin/dsbot-remote.mjs)
- [浏览器状态及未发送内容](../../../ds-bot/src/client/communication.js)、[thread intent](../../../ds-bot/src/client/communication-thread.js)
- [数据根与导入边界](../../../app/README.md)、[Windows 启动器](../../../start.ps1)
