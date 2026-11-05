# 测试联邦通信彻底清零指南

本次目标是**删除所有旧联邦通信数据，用新 Hub、新设备身份重新申请**，保留普通本地 Bot、本地聊天和模型配置。不是“退出 Hub”、保留历史或换一个数据目录。本文由操作者或其本地 Agent 在更新后执行；编写时没有操作真实 Hub 或客户端。

## 适用版本

- 本文按 `673b12b` 的数据布局以及本次新增的两个离线重置入口编写：`communication-hub/src/reset-cli.js`、`ds-bot/bin/dsbot-reset.mjs`。**必须先更新到包含这两个入口和配套 Host/浏览器代码的版本**。缺少命令时停下更新，不用旧 `forget-hub` 代替。
- Hub 和所有客户端使用同一兼容版本，Node 24+。原有 Hub SQLite `user_version=4`、客户端通信库 `user_version=5`；不要手改 schema、身份、游标或配对版本。
- 源码仓库首次运行客户端离线命令前，先准备其固定版本依赖：`npm --prefix ds-bot ci`、`npm --prefix ds-bot run harness`。也可按仓库规范将 `DSH_HARNESS` 指向兼容的现有 harness。它使用公开 Session 格式/导出接口做附件引用核查；不能拿缺失 SDK 的旧 CLI 跳过附件步骤。
- 更新源码不等于更新运行副本。Windows 源码启动器 `start.ps1` 会构建并刷新 app 插件；手动更新按 [app/README.md](../../../app/README.md) 构建插件、刷新 `app/node_modules/ds-bot`，再重启。安装版必须运行新安装包，不能继续开旧程序。
- 以下命令必须从**仓库根目录**执行。路径占位符全部换为实际绝对路径。Windows 用 `node.exe` / `npm.cmd`，Linux 用 `node` / `npm`。

## 最短执行顺序

1. 完整退出所有参与测试的客户端和 Host，关闭托盘及同一数据根的 Web/Desktop；停止旧 Hub，防止服务/快捷方式自动拉起。
2. 每台客户端运行离线重置，先核对默认 dry-run 范围统计和实际路径，再带确认词执行。**不能只清 Hub，也不能保留客户端旧 `communication` 配置、静态密钥、通信库或恢复日志。**
3. 移除客户端和 Hub 启动来源中旧通信共享密钥的精确环境变量注入，不清其他变量或整个 `.env`。
4. 对准确的 Hub 配置运行 Hub 离线重置。它会删除旧库、清空静态 `peers`，不会备份旧身份。
5. 核对管理模式、密码来源及 TLS，启动新 Hub，从新管理页取得新码；启动已清零的新客户端，逐台重新申请、审批。
6. 重新选择共享 Bot、交换新用户码、加联系人、建群。旧消息、联系人和群不会带回来。

旧 Hub 已失联不妨碍**离线客户端重置**，不需要先让旧服务器签署退出状态。清客户端不代表旧服务器或其他设备的副本已删除；完整测试环境清零必须对服务器及每台旧客户端分别执行。

## 1. 先核实路径，不输出秘密

保留一份仅含路径、代码版本、启动方式的操作清单。不输出完整配置、`.credentials.yaml`、`.env`、私钥、cookie 或消息正文。

### 客户端五类路径

1. **DSH_HOME**：app 设置 → General → Locations 的实际数据位置。`start.ps1 -DataRoot R` 使用 `R/data`。安装版可能由 `DS_BOT_HOME` 覆盖，不能根据 `%APPDATA%`、`~/.dsh` 或示例猜。
2. **插件 home**：实际 `id: bot` 配置的 `home`；未覆盖时为 `<DSH_HOME>/bot`。它不是整个 DSH_HOME。
3. **生效 profile/覆盖层**：app 普通 profile 为 `<DSH_HOME>/profiles/ds-bot/cordis.patch.yml`。自建启动器还可能通过 `patchFiles` 加载覆盖文件，例如测试启动器的 `<DSH_HOME>/bench.patch.yml`。逐一核对实际启动代码，所有会重新注入 `id: bot/config/communication` 的文件都传入 `--profile`，该参数可重复。
4. **凭据及 Session provider 路径**：默认本地凭据文件为 `<DSH_HOME>/.credentials.yaml`，可由 `@deepseek-ai/dsh-credentials-local` 的 `path` 覆盖。Session 路径取 `@deepseek-ai/dsh-session-persistence-jsonl` 的实际 `root`，不能只凭 `sessions` 名字猜。自定义 provider 不适用本地文件清理命令，需先确认其专用删除办法；不能绕过检查并声称清零。
5. **附件 provider home**：`@deepseek-ai/dsh-attachment-local` 实际生效的 `dshHome`，默认跟随 DSH_HOME，但可以被独立覆盖。将这个 home 传给 `--attachments-home`，不是传 `<附件 home>/attachments/v1` 子目录。还要核实该附件库的所有 Session 引用均在传入的 Session root 内；若其他 profile/root 共用附件库，不能在漏扫它们时判定对象独占。

仅列出 profile 文件路径的只读命令，不会打印内容：

```powershell
$DshHome = 'D:\REPLACE\actual-data-location'
Get-ChildItem -LiteralPath (Join-Path $DshHome 'profiles') -Filter cordis.patch.yml -Recurse -File | Select-Object -ExpandProperty FullName
```

```bash
DSH_HOME='/REPLACE/actual-data-location'
find "$DSH_HOME/profiles" -type f -name cordis.patch.yml -print
```

所列文件不一定都生效，不能对全部 profile 盲目重写。由本地 Agent 解析当前启动 profile 及其覆盖层，只报告上述路径、provider 类型和 `home`，不回显凭据。命令的 dry-run 只给范围统计，不能替你证明传入的是现用数据。

### Hub 数据库路径

以**实际 Hub 启动参数**的配置文件为准。`databasePath` 相对于配置文件所在目录解析，不相对于当前终端或仓库。下面只读脚本只输出数据库绝对路径：

```powershell
$HubConfig = 'D:\REPLACE\actual-hub-config.json'
node.exe -e "const f=require('node:fs'),p=require('node:path'),c=p.resolve(process.argv[1]),v=JSON.parse(f.readFileSync(c,'utf8')).databasePath;if(typeof v!=='string'||!v||v===':memory:')process.exit(2);console.log(p.resolve(p.dirname(c),v))" $HubConfig
```

```bash
HUB_CONFIG='/REPLACE/actual-hub-config.json'
node -e 'const f=require("node:fs"),p=require("node:path"),c=p.resolve(process.argv[1]),v=JSON.parse(f.readFileSync(c,"utf8")).databasePath;if(typeof v!=="string"||!v||v===":memory:")process.exit(2);console.log(p.resolve(p.dirname(c),v))' "$HUB_CONFIG"
```

嵌入式 `startHub()` 没用仓库 JSON CLI 时，应核对实际传入路径，不能套用示例文件。比如示例的 `./data/hub.sqlite` 并不能证明现用库在仓库。

在清空 `peers` 前，只记录旧 `peers[].credentialEnv` 的变量名，随后从 Hub 的实际服务环境、启动脚本或秘密来源中精确移除对应旧共享密钥，不输出值。清空配置引用不等于删除原密钥来源。若同一变量被其他用途共用，先将其他用途独立轮换/迁移，不删除其所需数据，也不能把旧通信密钥仍在来源中当作已清。TLS 和管理员密码是独立部署资源，不因删除旧配对而一并删掉。

## 2. 先停止全部写入

- 客户端正常退出，包含托盘和同一数据根的其他 Host。关闭旧通信页面，避免内存中的旧的未发送内容或回调继续提交。仅关窗口、断网或禁用通信都不够。
- Hub 前台终端按 Ctrl+C 等正常关闭。Linux 对已核对的 Hub PID 可发 `kill -TERM <PID>` 并等退出。自建 systemd/Windows 服务用原服务管理器停止准确服务并防止自动拉起，仓库不提供固定服务名。
- 核实相关进程已结束、原端口不再被该 Hub 监听；`/health` 超时不能证明已停止。不要 `killall node`、`taskkill /IM node.exe` 或删除锁文件绕过活跃检查。
- 本次默认**不创建备份、不移动到旧数据目录**。如果操作者另有回滚要求，必须在执行前明确选择停机一致快照，单独安全保存所有相关库及 sidecar、配置、provider、Session 和浏览器数据；备份仍含旧身份和消息，不属于已清除。没有完整快照不能保证恢复。

## 3. 每台客户端：离线删除所有联邦数据

先填写实际路径，默认只检查并返回范围统计，不删除。下面 `--profile` 的第二项仅在实际生效时添加；不存在的覆盖文件不要照抄。

```powershell
$ErrorActionPreference = 'Stop'
$PluginHome = 'D:\REPLACE\actual-data-location\bot'
$Profile = 'D:\REPLACE\actual-data-location\profiles\ds-bot\cordis.patch.yml'
$Credentials = 'D:\REPLACE\actual-credentials.yaml'
$Sessions = 'D:\REPLACE\actual-session-jsonl-root'
$AttachmentsHome = 'D:\REPLACE\actual-attachment-provider-home'
node.exe ds-bot/bin/dsbot-reset.mjs --home $PluginHome --profile $Profile --credentials $Credentials --sessions $Sessions --attachments-home $AttachmentsHome
if ($LASTEXITCODE -ne 0) { throw 'Dry-run失败，停止并核对错误。' }
```

```bash
set -euo pipefail
PLUGIN_HOME='/REPLACE/actual-data-location/bot'
PROFILE='/REPLACE/actual-data-location/profiles/ds-bot/cordis.patch.yml'
CREDENTIALS='/REPLACE/actual-credentials.yaml'
SESSIONS='/REPLACE/actual-session-jsonl-root'
ATTACHMENTS_HOME='/REPLACE/actual-attachment-provider-home'
node ds-bot/bin/dsbot-reset.mjs --home "$PLUGIN_HOME" --profile "$PROFILE" --credentials "$CREDENTIALS" --sessions "$SESSIONS" --attachments-home "$ATTACHMENTS_HOME"
```

核对 dry-run 成功和上述实际路径后，**另行执行**删除命令。若有生效覆盖层，dry-run 和删除命令中都要加相同的 `--profile <绝对覆盖文件路径>`。

```powershell
node.exe ds-bot/bin/dsbot-reset.mjs --home $PluginHome --profile $Profile --credentials $Credentials --sessions $Sessions --attachments-home $AttachmentsHome --confirm ERASE-ALL-FEDERATION-DATA
if ($LASTEXITCODE -ne 0) { throw '重置未完成；保持Host停止并核对错误。' }
```

```bash
node ds-bot/bin/dsbot-reset.mjs --home "$PLUGIN_HOME" --profile "$PROFILE" --credentials "$CREDENTIALS" --sessions "$SESSIONS" --attachments-home "$ATTACHMENTS_HOME" --confirm ERASE-ALL-FEDERATION-DATA
```

预期删除范围：

- 每个指定生效配置中 `id: bot` 的**整个 `communication` 子对象**，包括旧 URL、实例 ID、静态 `credentialEnv`、SDK 引用、暂停/恢复选择等。只把 `enabled` 设为 false 仍会留下旧配对。
- 凭据 provider 中匹配 `ds-bot/communication-<32位小写十六进制>` 的联邦记录，包括私钥、旧 Hub/CA 信任、待审批、暂停、恢复及离开状态。仅额外删除旧配置精确引用的通信 `credentialEnv` ref，保留模型等其他 `refs` 和所有非联邦记录，不删除整个凭据文件。
- `<插件 home>/communication.sqlite` 及其 sidecar；`communication-hubs/` 中通过验证的所有通信作用域。包括所有 Hub，而不是只清当前选中项。其联系人投影、群成员、消息/事件、收发箱、游标、回执、去重、Session 绑定、关系记忆和待恢复工作全部丢失。
- 通信绑定对应的专用 `communication-workspaces/<binding.id>`，以及由 Session ID、cwd 和通信绑定共同验证的远程 Session 日志目录。需删该 Session 的**所有历史格式世代**，不只是当前 `session.vN`，否则旧日志仍可被重新发现。普通本地 Bot/群 Session 不在此范围。
- 默认本地附件 provider 中，经全部 Session 历史世代引用分析确认的联邦独占图片/文件对象和文件别名，以及可再生的图片请求缓存。普通本地聊天仍引用的相同字节作为普通聊天数据保留，不再保留其联邦 Session 引用。路径、引用范围或对象归属无法证明时拒绝清理并报告未完成，不能默认留着联邦独占对象后报成功。
- 新的空通信重置标记使新版客户端清除当前 origin 的 `ds-bot:communication:*` 浏览器项，包括未发送内容、未决发送、操作 ID、thread intent、选择/隐藏状态。每个用过的浏览器 profile、origin、标签页都要重新打开/刷新同一新 Host 才能处理其存储；关闭不用的旧标签页。其他站点、登录和非通信存储保持不变。旧浏览器副本没有自动远程擦除保证。

另外从**实际启动来源**移除旧通信共享密钥注入：读取旧配置引用的精确 `credentialEnv` 名称，旧默认名为 `DSBOT_COMMUNICATION_CREDENTIAL`；检查原服务环境、启动脚本、项目/数据根 `.env`，只删除该项，不输出其值。退出旧 Host 会清掉其内存中的 legacy credential lease，不存在一个需要手删的通用 lease 文件。不要删除整个 `.env`、模型 API key 或所有 `DSBOT_*`。

执行磁盘删除成功应返回 `erased:true`、`dryRun:false`，同时明确返回 `complete:false`：此命令不能代替服务器、所有浏览器和旧启动密钥来源的验收。`clearLaunchEnvironment` 是还需移除的旧通信变量名，`launchEnvironmentCleanupPending:true` 表示这项仍待处理。重跑同样的 dry-run，核对 `configurationFiles`、`pairingRecords`、`queueFiles`、`remoteDirectories` 均为 0。`exclusiveAttachmentObjects` 报告本次要删除的联邦独占对象，`sharedAttachmentObjectsPreservedForOrdinarySessions` 只允许普通 Session 仍引用的共享对象。`browserCleanupPending:true` 提醒浏览器仍需刷新，不代表所有浏览器已处理。失败返回 JSON `ok:false`、`incomplete:true` 和 `error.code`，有 `error.target` 时它是需要核对的安全路径，不含秘密正文。比如 `RESET_ATTACHMENT_OWNERSHIP_UNPROVEN` 代表不能证明附件独占归属，必须处理具体残留或报告重置未完成，不能跳过附件参数。中断后的 `communication-reset.pending.json` 会阻止 Host 恢复旧工作；保持停机，纠正错误后用相同参数和确认词重跑，不手删标记。活动进程、路径/链接异常、格式不支持、Session 归属无法证实时必须停下核对；不要用 `rm -rf bot`、`sessions`、DSH_HOME、用户自己的 `~/.dsh` 或全新数据根替代。命令只认识显式指定的本地 provider，外置文件和其他机器副本须分别处理。

**普通本地 Bot 身份、配置、普通本地聊天/群/记忆、模型凭据、团队工作区保留。** 共享附件必须按引用清理，不能删整个 `attachments` 损坏普通聊天，也不能把远程独占文件留在共享库里就称为完成。默认 provider 的对象位于其实际 `dshHome/attachments/v1`，请求图片缓存位于 `dshHome/cache/attachments/request-images`；自定义 backend、多个未覆盖的 Session root、损坏/未知日志或无法确认归属的孤儿对象都应明确报告具体残留与阻塞，**完整重置未完成**。配对已能重新申请不等于所有清理完成。

其他机器、旧浏览器、导出/备份和用户主动复制到普通聊天/记忆的内容需分别核对处理。未覆盖的副本不能默认为已清除。应用层文件删除也不承诺介质级安全擦除。

## 4. Hub：删旧库并清空旧静态授权

确认所有客户端和 Hub 已停。在仓库根目录运行，配置路径必须和第 1 节核对的一致：

```powershell
npm.cmd --prefix communication-hub run reset -- --config $HubConfig --confirm "DELETE ALL HUB DATA"
```

```bash
npm --prefix communication-hub run reset -- --config "$HUB_CONFIG" --confirm 'DELETE ALL HUB DATA'
```

该命令**没有 dry-run**；不带或写错确认词会拒绝。先读帮助可用 `npm --prefix communication-hub run reset -- --help`。

- 删除准确 `databasePath` 及 `-wal`、`-shm`、`-journal`；将现用配置 `peers` 改为空数组，避免旧共享密钥设备被新库再次授权。
- Hub ID、旧设备/公钥、用户码、申请、联系人、群/成员/所有权/权限、消息/内联附件、事件、投递/回执、游标、去重、头像/昵称、审计及库内管理密码校验全部丢失。旧静态 peer 共享密钥的外部注入来源按第 1 节另行精确移除，不因 `peers=[]` 自动消失。
- 保留地址、端口、TLS 证书/私钥来源、公开 CA 和其他管理配置。保留空 `<databasePath>.lock` 供 OS 协调，不含旧身份/恢复数据；不要手删它。
- 活跃 Hub 返回 `HUB_ACTIVE_STOP_REQUIRED`，应停止准确进程后重试，不绕过锁。中断后启动报 `HUB_RESET_INCOMPLETE` 时保持服务关闭，检查错误并重跑同一命令完成；不要手改中断标记、换库或混入旧 sidecar。

## 5. 建新 Hub，拿当前有效的配对码

1. 用现有安全方式重新提供 `management.adminPasswordEnv` 引用的管理员密码（至少 16 字符）。旧库里的校验记录已删，不能依赖它。不要把密码写进 argv、本文或 Git。
2. 本次使用管理审批配对：核对 `management.enabled: true`、正确可达的 `management.url`（例如实际的 `wss://…/communication`）、TLS/CA。重置只清旧 `peers`，不会替你开启管理模式。
3. Windows：`npm.cmd --prefix communication-hub start -- "$HubConfig"`；Linux：`npm --prefix communication-hub start -- "$HUB_CONFIG"`。打开**本次启动日志**的 `/admin/`，重新登录，从当前 Hub 取得新码。旧 Hub ID 和旧复制码不再使用，即使 URL 和证书没变。
4. **v2 不是软件版本号。** 配了 `management.pairingCaFile`（相对 Hub 配置文件的公开 CA PEM），并使用匹配的 TLS 证书/私钥和 `wss://` 地址时，新 Hub 生成签名 `dsbot-hub:2:` 码，最长有效七天。没有该配置时当前程序仍可生成 `dsbot-hub:1:`，它仅使用系统现有 TLS 信任，不能引导私有 CA。需要私有 CA/v2 时先正确配置，不手改码前缀、不关 TLS 校验。
5. 启动**新版、已重置**的原客户端，不换 DSH_HOME。Remote communication → Add a device，粘贴新码，核对新 Hub ID、地址及 CA 指纹后明确申请。管理员核对申请人和设备公钥指纹后审批。每台设备生成独立新密钥，不复制旧记录或别人的身份。
6. 明确重新选择共享本地 Bot（默认无）、交换新 Human 用户码、申请/接受联系人、重新建群/邀请/权限。保留的是本地 Bot，不是它原来的联邦身份或发布关系。

若仍出现“旧共享密钥配对”或 `LEGACY_HUB_SWITCH_REQUIRES_REENROLLMENT`，不要再重置新 Hub。先停止该客户端，查它是否运行旧插件、漏传生效覆盖层、用了另一个 home，或原启动来源再次写回 `communication`。只清服务器不能解决客户端旧配置。

## 6. 验收与回滚边界

- 完成必须同时满足：Hub 无旧设备/申请/联系人/群/消息；每台客户端无保存的旧 Hub、静态选中项、旧通信队列/远程 Session、待发意图或恢复工作；所有远程独占附件和其缓存已处理，每个旧浏览器存储已清；没有未解决的 provider/引用范围/孤儿对象/旧密钥来源残留报告。本地 Bot、普通群/聊天和模型配置仍在。
- 有任一项尚未验证或明确残留时，记录实际目标、原因和下一步，报告“重置未完成”，不能只因 `erased:true`、新身份能配对或 `/health` 成功就报完整清零。
- 配对后确认新 Hub ID、新设备 ID/公钥，不再出现旧联系人/群。用两台新身份互发唯一标记消息，并测试共享 Bot DM/新群；正常重启与短暂断线后不重发旧消息、不恢复旧群。
- `/health` 成功只证明服务就绪。新消息双向到达才是通信验证；清零不证明连接缺陷已经修复。异常时记录脱敏错误码和消息 ID，不提交秘密或正文。
- 默认不可回滚。若另有完整停机快照，回滚也必须先停全部新进程，并成套恢复匹配的 Hub 库、sidecar、配置、客户端 provider/队列/Session/浏览器状态及旧二进制，不能只还原主 `.sqlite` 或把旧身份导入新 Hub。新旧消息不能自动合并。快照不完整时不保证恢复。

## 核对来源

- 本次入口：[Hub 离线清零](../../../communication-hub/src/reset-cli.js)、[客户端离线清零](../../../ds-bot/bin/dsbot-reset.mjs)。
- [Hub 路径解析、退出](../../../communication-hub/src/cli.js)、[Hub 服务与 TLS](../../../communication-hub/src/server.js)、[Hub 配对码说明](../../../communication-hub/README.md)
- [Hub 数据与 schema](../../../communication-hub/src/store.js)、[管理数据和 Hub ID](../../../communication-hub/src/management-store.js)
- [客户端配置、配对记录和队列作用域](../../../ds-bot/src/host/federation/onboarding.js)、[旧共享密钥内存租约](../../../ds-bot/src/host/federation/legacy-credential.js)
- [队列和 Session 绑定](../../../ds-bot/src/host/federation/queue-store.js)、[专用工作区和恢复](../../../ds-bot/src/host/federation/runtime.js)
- [浏览器通信存储](../../../ds-bot/src/client/communication.js)、[thread intent](../../../ds-bot/src/client/communication-thread.js)
- [app profile](../../../app/src/profile.mjs)、[app 数据位置](../../../app/README.md)、[源码启动器](../../../start.ps1)
