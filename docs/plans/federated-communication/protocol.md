# 跨实例通信协议与可靠性规范

> Current routing amendment: [explicit Bot activation](explicit-bot-activation.md).
> Bot display mentions no longer authorize group activation. New peers require
> explicit-bot-activation and schema v3; upgrade Hub and clients together. This
> supersedes older examples that infer Bot handoff from final body @ text.

- 状态：建议设计，供后续实现与验收使用。
- 适用基线：DS-Bot `5c514ad70d5f3fd1c3b72b2e76e530bef50989d7`。
- 目标协议：`dsbot-communication/1`。
- 本文的字段、消息类型、错误码和存储结构均为拟新增设计，不代表仓库已有接口。
- “必须”表示互操作或可靠性要求；“建议”表示第一版实现选择。

## 1. 范围与基本不变量

第一版连接多个独立 DSH 实例，实现指定群聊和双人私聊的共享通信。
参与者可以是 Human 或 Bot；每个实例保留自己的模型、工具、会话、记忆和文件环境。

1. 一个通信会话只有一份由 Hub 确认的规范事件序列，各端显示其授权投影。
2. 一条群消息分发给全部有资格接收的群成员，但只有路由选中的 Bot 进入 AI 收件箱。
3. 事件显示、读取历史和补齐投影本身不得触发模型；原来未完成的 Bot 投递可按其持久收件资格恢复。
4. 发送者身份由认证入口确定，不能由模型或消息 JSON 自报。
5. 本地原有私聊和记忆不自动上传；仅同步明确创建或接入的通信会话。
6. 协议只定义通信、回执和投递状态，不定义业务审批、任务流程、执行控制或群记忆同步。
7. 进度是普通聊天文本；协议不解释“正在开发”“已经完成”等文本为业务状态。
8. 本地 Session 不跨机器共享；网络可重试，实际模型和工具副作用不保证恰好发生一次。

## 2. 参与者与稳定身份

| 字段 | 含义 | 稳定性要求 |
|---|---|---|
| `instanceId` | 一个独立实例的身份 | 首次配置生成，地址变化不改变 |
| `principalId` | 一个 Human 或 Bot 的全局身份 | 使用实例命名空间与稳定本地标识 |
| `kind` | `human` 或 `bot` | 由所属实例注册并校验 |
| `homeInstanceId` | 参与者所属实例 | 不能由任意对端修改 |
| `displayName` | 界面中的名字 | 可重名、可修改，不参与路由 |
| `instanceLabel` | 用户可读的实例名称 | 仅用于远程标识和同名区分 |

建议的形式为 `human:<instanceId>:<localId>` 与 `bot:<instanceId>:<localId>`。
IP、主机名、显示名、模型名都不能当作参与者主键。
同名的两个 Chief 使用不同身份；界面应显示“Chief · 实例 B”等来源信息。
“远程”是相对于当前实例计算的展示属性，不是参与者永久不变的类型。

短期允许每个实例仅有一个本地人类账号；两个实例分别映射 Human A、Human B。
这一步不要求先实现单个 DSH 的多用户登录系统。
若以后同一实例支持多个人类账号，必须使用真实登录主体生成不同 `principalId`。
复制数据目录后作为第二个独立实例启动时，必须重新生成实例身份，不能同时冒用原身份。

## 3. 认证、配对与权限边界

实例之间完成一次明确的配对信任，注册允许公开的参与者和通信范围。
有效信任范围内的正常收发消息不逐条弹权限确认。
实例连接凭据与通信内容分开保存，不进入模型上下文、群日志或普通诊断输出。

- Human 发送入口从本机已认证用户恢复作者身份，不接受前端任意指定作者。
- Bot 发送入口从当前本地 Bot 会话恢复作者身份，不接受模型指定其他 Human 或 Bot。
- Hub 将连接身份、作者所属实例、作者注册记录和会话成员资格共同校验。
- A 实例不能声明作者属于 B 实例；Bot 工具不能把自己声明成 Human。
- `Main Bot`、群管理员和本机用户权限不通过消息正文或自报字段传播。
- 远程 Chief 的名字和角色标签不会使它获得本机 Chief 权限。
- 远程 Human 发言保留真实来源，不转换成本机用户发出的管理指令。

Hub 信任已配对实例的宿主认证结果；每个实例必须分别保护 Human 入口与 Bot 入口。
群成员管理使用独立的认证操作，不能通过聊天文本“把某人加入群”直接修改成员表。
消息接收方仍按自身的权限规则处理内容；网络身份验证不等于授权任意本地工具操作。

配对只公布实例所有者选定的 Human/Bot，不自动公开整个本地团队。
群创建者初始具有群管理权；后续管理资格显式记录，不能把负责默认答复的管理员 Bot 自动当作所有成员的管理者。
邀请在目标所有者已授权的信任范围内可以自动接受，否则显示为待接受；接受并产生成员事件后才开始投递。
参与者可自行退出，群管理者可邀请和移除成员；正常范围内的 Bot 可调用同样的通信操作，不需要增加业务审批流程。
管理操作使用稳定 `operationId` 幂等处理。重试建群、邀请或接受不能重复生成群、成员资格或通知。

## 4. 会话、群与私聊

`conversationId` 是通信会话的全局身份，独立于本地群名和本地 Session。
会话类型只有 `group` 与 `dm`；本地需要保存 `conversationId → localViewId` 映射。

| 类型 | 参与者 | 可见范围 | 新增参与者 |
|---|---|---|---|
| `dm` | 固定两个不同的 `principalId` | 仅这两个参与者 | 必须新建群或另一会话 |
| `group` | 显式成员集合，包含 Human 和 Bot | 当前授权成员 | 经成员管理操作加入 |

私聊可以是 Human–Human、Human–Bot 或 Bot–Bot。
不得把两人私聊在原 ID 下变成三人会话，以免旧私聊历史被错误公开。
V1 每一对参与者只有一个通信私聊。将两个完整 `principalId` 排序后以规范 JSON 数组编码为 `dmKey`，
Hub 对 `dmKey` 设置唯一约束，在事务中 get-or-create。反向打开、双端并发创建和请求重试均返回原 `conversationId`。
本地关闭、隐藏私聊不删除此唯一绑定；不得用显示名拼接或仅靠前端缓存去重。
B 要看到 A/J 在群中的发言，B 本人必须作为 Human 成员加入该群。
K 在群中，不自动等于 K 的所有者 B 已经是该群的人类成员。

加入群时记录 `joinSeq`，并由 Hub 返回获准的起始水位。
第一版新成员默认从 `joinSeq` 开始接收；分享此前背景时，将经允许的旧摘要作为新消息发送。
本地已有的 Bot 私聊不因创建通信映射而被整段上传或合并进新群。
新建联邦私聊必须在界面明确显示为通信会话；是否可映射到已有界面入口，需在 P0 验证。

每次加入建立新的 `membershipEpoch`，投递和历史授权同时关联参与者及该次成员资格。
同实例其他成员的缓存不能扩大本人的可读范围；重新加入从新的 `joinSeq` 开始。

## 5. 文本消息与大小约束

第一版支持 UTF-8 文本、Markdown、结构化提及、消息引用和普通文本进度。
不包含任意文件上传下载、远程目录、附件同步、私有记忆或内部 Session 导出。
图片和附件地址只能作为普通链接展示；协议不代取内容，也不保证对方可访问。
外部地址不能隐式触发文件传输；Markdown 中的可执行内容由界面正常隔离。

建议 `maxTextBytes = 65536` 作为第一版可配置起点，即 64 KiB UTF-8 正文字节。
Hub 在握手中公布文本、信封和成员数量等有效上限；客户端发送前据此检查。
字节限制不是字符限制，中文和多字节字符必须按编码后的长度计算。
超限返回 `PAYLOAD_TOO_LARGE`，包含实际字节数和允许上限。
不得静默截断、丢弃尾部、改成摘要，或自动拆成多条改变原有语义。
需要拆分时由发送方明确处理，并为每条新消息生成独立 ID。

## 6. 建议消息信封

以下为建议示例；`author` 由可信入口填写，Hub 仍必须校验。

```json
{
  "protocol": "dsbot-communication/1",
  "type": "message.publish",
  "messageId": "019d0000-0000-7000-8000-000000000001",
  "conversationId": "conv-7b83",
  "author": {
    "principalId": "bot:instance-a:chief-j",
    "homeInstanceId": "instance-a",
    "kind": "bot"
  },
  "clientCreatedAt": "2026-11-03T01:00:00Z",
  "content": {
    "format": "markdown",
    "text": "@Chief K 请看看这个接口问题。"
  },
  "mentions": [
    { "principalId": "bot:instance-b:chief-k" }
  ],
  "replyToMessageId": null
}
```

客户端必须先持久化完整消息与 `messageId`，再尝试网络发送。
`clientCreatedAt` 用于显示和诊断，不用于会话排序或权限判断。
Hub 接受后附加 `conversationSeq`、`serverAcceptedAt` 和规范化载荷哈希。
Hub 为每个目标参与者创建稳定 `deliveryId`，重试不能改变该投递身份。
`messageId` 标识同一发言，`deliveryId` 标识该发言到某个参与者的投递，两者不能混用。
建议以 SHA-256 计算固定规范化规则下的不可变载荷哈希。
哈希覆盖作者、会话、正文、提及和引用等不可变字段，不覆盖服务端序号或回执时间。
不向协议暴露本地 `sessionId`、会话目录、认证令牌或模型内部消息。

## 7. 提及、引用与 AI 收件箱

Hub 使用成员快照和约定的路由策略一次性确定消息接收范围。
每个客户端不得再用自己的一套同名匹配规则重新决定收件 Bot。

- 群的规范消息对全部授权成员可见，不因只提及 K 就从 B 的界面消失。
- `@Human` 产生该人的通知；不会因此启动这个人的 Chief。
- `@Bot` 将消息投递到被点名 Bot 对应会话的 AI 收件箱。
- 私聊发给 Human 时只形成通知；发给 Bot 时可以进入该 Bot 的该私聊收件箱。
- 人类群消息无提及时，按群配置选择默认收件 Bot，例如沿用“管理员先答”。
- Bot 无提及的普通群回复只广播显示，不自动唤醒全体 Bot。
- `@all` 等群广播提及必须使用显式策略检查，不由任意成员的普通文本自动放大。
- 引用、代码段、链接中的名字不构成活动提及，沿用客户端与服务端一致的解析规则。
- 提及菜单输出稳定 `principalId`；纯文字输入有歧义时返回明确错误，不能猜同名对象。
- `replyToMessageId` 必须指向同一会话中作者有权引用的消息。
- 引用关系用于展示与上下文，不自动构成再次唤醒被引用作者的指令。

V1 的群路由配置固定为以下两种，配置及 `routingVersion` 由 Hub 持久保存：

| `routingMode` | 无活动提及的人类消息 | 条件 |
|---|---|---|
| `admin` | 交给唯一的 `adminBotPrincipalId` | 管理员必须是当前 Bot 成员；有管理员时默认采用 |
| `mentionsOnly` | 只展示，不启动模型 | 无管理员时的默认模式 |

有活动提及时只按提及处理；只有 `@Human` 不再补叫管理员。无提及的 Bot 回复在两种模式中都只展示。
移除管理员时，在同一个成员变更事务中切换为 `mentionsOnly` 或指定新的合法管理员；仅断线不改变管理员。
路由变更只影响之后接受的消息，既有投递保留原路由版本和收件资格。首版不提供联邦全员轮流模式。

网络防回音依赖稳定 ID、幂等和单一消息路由，不设置固定对话跳数上限。
有进展的 Bot 接力可以继续；原有对话空转检测属于本地行为，应与网络重投区分。
任何历史回放、界面刷新或同步补齐，都不得重新计算为一次“新发言”。

## 8. 本地上下文绑定

每个 Bot 的通信上下文以 `(conversationId, localBotRef)` 绑定。
其中 `localBotRef` 只由 Bot 所属实例解析为本地 Bot，不能解析成远端 Session。
同一个 K 在一个群、另一个群和一个私聊中的上下文分别保留。
读取群上下文时仅纳入该通信会话获准的事件，不拼接 K 原有私聊、其他群或记忆。
历史分页、单消息查询、搜索、引用展开、通知、UI 渲染及 Bot 上下文构造，
均按实际 `principalId + membershipEpoch` 校验阅读范围；持久消息体可去重共用，授权视图不能共用。
新消息引用了读取者入群前的旧消息时，只显示受限引用占位，不在信封、预览或 AI 输入中自动展开旧原文。
要分享旧背景，由有权读取的发送方显式发送新的文本或摘要消息。

本地 Session 的创建、分段与压缩遵循现有 DS-Bot 机制。
更换本地会话段不改变 `conversationId`、历史消息 ID 或跨机引用关系。
远端成员在本地名册中是联系人/成员代理，不应伪造可运行的本地 Bot Session。
本地通信投影中的一条消息必须保留其原作者、原会话及 `messageId`。
同步导入函数与本地发送函数必须分开，导入消息不能再次提交为新的出站消息。

## 9. Hub 事务与最小存储

建议第一版使用 Node.js 与单节点 SQLite；所有规范写入经过一个串行写入入口。
数据库文件只由 Hub 本机访问，不以网络共享目录实现多个实例同时写库。
WAL 可以改善读写并发，但不把 SQLite 变成多节点写入系统。

| 存储 | 关键内容 |
|---|---|
| `instances / principals` | 已配对实例与其公开身份 |
| `conversations / memberships` | 会话类型、成员、历史边界和成员版本 |
| `conversation_events` | 按会话排序的规范消息与成员事件 |
| `deliveries / hub_outbox` | 每个目标的可靠投递记录，含稳定 `deliveryId` |
| `receipts / cursors` | 投递回执、已读水位及连续同步水位 |
| 客户端 `outbox / inbox` | 未确认发送、已持久接收及消费记录 |
| 客户端 `projections` | 规范消息与本地展示/上下文的映射 |
| 客户端 `exports` | 绑定会话内可发布的 Bot 源输出、稳定消息 ID 与连续导出游标 |

`deliveries` 对 `(messageId, recipientPrincipalId)` 设置唯一约束，并保留通知/AI 收件标志。
同一载荷可以只在网络上传一次，但各参与者的 `deliveryId` 和收件资格不能合并丢失。
Hub 接受新消息时，在一个数据库事务内完成身份/成员检查、幂等检查、
会话序号分配、规范事件写入和目标投递记录写入，然后才回复已接受。
进程在事务提交前崩溃，重试可重新处理；提交后崩溃，重试返回原结果。
不得先回复成功，再在内存中等待写事件或创建投递记录。
规范日志仅保存明确参与通信的消息，不采集原有聊天、工具日志、推理或记忆。

## 10. 序号、重试与哈希冲突

`conversationSeq` 由 Hub 对会话事件分配，单调递增；成员变更也参与同一顺序。
客户端时间戳不决定先后，跨机器时钟差异不能造成消息丢失。
重试必须保持相同 `messageId`、作者、会话和不可变载荷。

- 相同 ID 与相同载荷：返回原有接受结果，不新增事件，不重新创建 AI 收件项。
- 相同 ID 与不同载荷：返回 `MESSAGE_ID_CONFLICT`，不得覆盖原消息。
- 未授权连接查询已存在的 ID：仍先验证权限，不泄露原消息及其接收状态。
- 发送方想修改内容时，第一版应发新消息并引用旧消息，不复用原 ID。
- 暂时网络错误采用指数退避与抖动；错误恢复后重试原消息，不生成新 ID。
- 明确的协议或权限错误不无限重试，保留可见的失败原因。

第一版可以不支持编辑和删除正文；若以后加入，必须定义新的事件语义。
不能在没有协议约定时把同 ID 的不同正文解释为“编辑”。

## 11. 接收、回执与已读

目标实例收到消息后，先把规范事件和收件记录落入本地持久库，再确认接收。
一个实例承载多个成员时，可合并传输同一载荷，但成员通知和 Bot 收件资格分别检查。

| 回执 | 可以证明 | 不能证明 |
|---|---|---|
| 连接层 ACK | 某个网络帧得到响应 | 消息持久化、人类已读或 AI 已处理 |
| `hubAccepted` | Hub 已提交规范事件及投递记录 | 目标在线 |
| `targetStored` | 目标实例已经持久接收 | 界面可见或模型已经接收 |
| `uiApplied` | 本地授权视图已应用消息 | 人类看过消息 |
| `humanRead` | 对应 Human 的界面确认已读水位 | 同机其他 Human 或 Bot 也已读 |
| `aiAccepted` | 指定 Bot 的该会话已可靠接纳输入 | 模型已回答或工具动作成功 |

Bot 回答以一条新的规范消息表示，可通过引用关联输入；不以网络 ACK 冒充回答。
任何状态必须绑定对应参与者，不能以“某机器已收到”显示“所有成员已读”。
无需 AI 回应的消息不得无限显示“等待 AI”，界面应区分通知与 Bot 收件。

## 12. 游标、断线补齐与离线积压

客户端只提交已经连续持久化并应用到的同步游标。
收到序号 12 而缺少 11 时，必须先保留 12 并请求缺口，不能把游标直接推进到 12。
上下文输入依赖之前消息时，先补齐获准的上下文，再交给本地接收入口。
重连携带会话水位；Hub 从其后回放，重复到达的事件由 ID 和序号去重。

会话快照必须声明所覆盖的水位；快照和增量的衔接不能漏掉并发消息。
若历史因保留策略已无法补齐，返回 `HISTORY_GAP`，不能把缺失历史伪装成同步成功。
第一版不静默过期离线消息；积压超过容量时明确拒收新消息或报告投递受阻。
任何未来保留期限必须显式配置和告知，且不能偷偷将已接受消息当成已送达。
显示“离线”时保留待投递状态与最后成功连接时间，不伪造对方的回应。

Hub 为每个成员时期返回可信的授权起始水位，连续性从该位置计算，不等待入群前无权获取的序号。
实例传输去重水位与各参与者的投影、已读和 Bot 消费水位分别维护；B 已同步不能证明同机 K 已接收或已读。

恢复分为两条通道：`conversation.sync` 仅补齐有权读取的规范历史；未完成投递按原 `deliveryId` 恢复。
历史帧不能重新解析提及并创建投递。K 离线期间已生成的有效 AI 收件项，重连补齐上下文后仍应交给 K 一次；
此后刷新或回放同一历史不再交给 K。事件去重与投递消费分别记账，不能因界面已有消息就跳过尚未消费的投递。

## 13. 重启恢复与 DSH 非原子边界

客户端必须按 `deliveryId` 保存“已收到”“已投影”“已提交给 Bot”的持久消费记录。
重启扫描未完成记录时，先对账，不能把所有非完成记录直接再次送入 DSH。
插件数据库事务与 DSH 会话写入通常不属于同一事务，必须正视中间崩溃窗口。

建议 DSH 持久输入保留可核验的 `source.deliveryId`，同时保留 `source.messageId` 与 `conversationId`。
恢复时以 `source.deliveryId` 核验对应参与者的输入，不能只因某处出现相同正文就判定成功。
这些是要求验证可用性的建议元数据，不表示当前 DSH 已暴露同名公开接口。
实施者必须先证明：通过公开 API 可以写入、找回并核验同一规范消息的来源。

1. 写入前保存意图与消息来源标识。
2. 成功后保存实际本地记录映射。
3. 中间崩溃后检查是否已有相同来源的 DSH 记录。
4. 已有且可证明对应时补全映射，不重复投递。
5. 可证明未写入时恢复投递。
6. 无法证明有无写入时标为 `injection_unknown`，显示需要核对并阻塞该验收用例，不盲目重投。

若公开 API 不足以可靠核验，应记录能力缺口并限制自动恢复，不修改 DSH 内部存储。
同一消息的显示去重、AI 输入去重和外部工具副作用是三件事。
本协议不承诺模型调用及文件、命令或外部系统动作的 exactly-once。

### Bot 回复导出也必须恢复

已经持久生成的 Bot 回复到本地 outbox 之间同样存在崩溃窗口。
只导出明确绑定通信会话且允许发布的最终文本或显式发送动作，不扫描并广播普通本地会话、推理和工具内部日志。
使用公开 API 提供的稳定源事件标识，保存 `(绑定 ID, 源 Session ID, 源事件 ID, 输出片段 ID) → messageId` 唯一映射；
具体字段以 P0 验证结果为准，不能以正文哈希代替源输出身份。
Session 换段时保留旧绑定和导出位置，不能只扫描当前段。

映射、完整 outbox 载荷与对应导出位置在同一本地事务中保存，再尝试联网发送。
重启先从持久输出对账：已映射的输出重用原 `messageId`，未导出的合格输出补入 outbox，不重新调用模型生成替代回复。
若公开 API 不能稳定定位已持久的源输出，标为 `export_unknown`，说明能力缺口并阻塞相应可靠性验收。
仍在生成而尚未持久完成的文本不算已发布消息；UI 必须区分流式预览和已持久提交的发言。

## 14. 成员移除与信任撤销

成员变更在 Hub 事务内更新资格，并写入有序成员事件。
移除成员时，将其尚未完成的积压投递转为明确的 `revoked`，不继续补送旧积压。
Hub 在实际发出投递时再次检查当前资格，不能只依赖最初创建投递时的成员快照。
移除之后的新消息不为该成员生成投递，也不允许其继续查询会话增量。
已经发出的网络帧不能保证追回；接收端在获知撤销后必须阻止尚未消费的 Bot 收件项。
已经被成员实际读取的内容无法通过移除操作使其“未读”。

同实例仍有其他合法成员时，仅撤销被移除者的资格，不中断其他成员的同步。
对端断线期间发生撤销，重连时先核对当前成员版本，再恢复投递和本地收件消费。
`targetStored` 之后但尚未 `aiAccepted` 的 Bot 投递仍属于可撤销的未消费项。
已经确认 `aiAccepted` 的输入不能承诺追回；不能把通信层撤权解释为终止正在执行的模型或工具。
`revoked` 为不可恢复终态。重新入群产生新的 `membershipEpoch`，不能复活旧投递，
也不能从同机其他合法成员的缓存补入自己未获授权的事件。重启后的消费者完成资格对账前不能释放待消费项。
撤销实例信任时停止其后续认证与投递，保留可审计的失败/撤销状态。
拒绝和撤销必须可见；不能把消息从界面悄悄消失并标成成功。

## 15. 版本、能力与明确错误

握手必须交换协议主版本、支持能力、载荷上限、实例身份和连接 epoch。
第一版能力至少明确声明文本、Markdown、稳定身份提及、群/私聊、引用与历史回放。
无法支持必要能力时拒绝建立对应会话，不静默降级成丢失作者或引用的纯文本转发。
一个实例新连接替代旧连接时，Hub 拒绝旧 epoch 继续提交新通信操作。

| 错误码 | 含义与处理 |
|---|---|
| `PROTOCOL_VERSION_UNSUPPORTED` | 主版本不兼容，停止自动重试并提示升级 |
| `UNSUPPORTED_CAPABILITY` | 缺少必要能力，说明具体能力 |
| `UNAUTHENTICATED / AUTHOR_MISMATCH` | 认证或作者绑定失败，拒绝处理 |
| `NOT_A_MEMBER / MEMBERSHIP_REVOKED` | 无会话资格，停止对应投递 |
| `UNKNOWN_MENTION / AMBIGUOUS_MENTION` | 提及无效或同名不明，要求明确对象 |
| `INVALID_REPLY_TARGET` | 引用不存在、跨会话或无权引用 |
| `PAYLOAD_TOO_LARGE / MESSAGE_ID_CONFLICT` | 载荷超限或重试内容冲突 |
| `UNSUPPORTED_CONTENT` | 首版不支持的附件或媒体请求，明确拒绝且不生成消息 |
| `HISTORY_GAP / STORAGE_UNAVAILABLE` | 历史缺口或不能持久化，不报告成功 |

首轮验证使用同一机器的两个独立 DSH 数据目录、两个本地人类身份与一个 Hub。
仅回环地址可用于无 TLS 的本机联调；跨机器部署使用受认证的加密连接。
验收必须包含断线、重启、重复帧、乱序缺口、同名 Bot、撤销积压与明确错误显示。

## 16. 仓库依据与实现边界

以下来源用于确认现有行为；本文的跨机协议是新增设计，不是对现有功能的描述。

- [群聊设计：提及、默认回答、并发接力与群内上下文](https://github.com/KarlToon-FFAC/DS-Bot/blob/5c514ad70d5f3fd1c3b72b2e76e530bef50989d7/docs/plans/2026-10-07-group-chat.md)。
- [角色与权限：Main Bot、群管理员与本地权限范围](https://github.com/KarlToon-FFAC/DS-Bot/blob/5c514ad70d5f3fd1c3b72b2e76e530bef50989d7/docs/plans/2026-10-07-roles-and-permissions.md)。
- [安全模型：其他 Bot 消息与本机工具之间的信任边界](https://github.com/KarlToon-FFAC/DS-Bot/blob/5c514ad70d5f3fd1c3b72b2e76e530bef50989d7/SECURITY_MODEL.md)。
- [DSH 让步记录：公开插件接口的限制](https://github.com/KarlToon-FFAC/DS-Bot/blob/5c514ad70d5f3fd1c3b72b2e76e530bef50989d7/docs/plans/2026-10-13-dsh-concessions.md)。
- [贡献约束：使用 DSH 公开接口，不补丁修改上游](https://github.com/KarlToon-FFAC/DS-Bot/blob/5c514ad70d5f3fd1c3b72b2e76e530bef50989d7/AGENTS.md)。

# 群治理增补（2026-11-03）

本段记录 P0–P4 检查点后的用户追加需求，详细语义见 [群治理设计](group-governance.md)。
握手新增必需能力 `group-policy`；旧客户端返回 `UNSUPPORTED_CAPABILITY`，不做隐式全权降级。

- Membership 增加 `role: owner|admin|member`、按类型限定的 `speakingMode`、
  `ownerPrincipalId`、`dissolved`，保留 `membershipVersion` 与旧 manager 投影。
- Human 模式为 `readOnly|speak`，Bot 为 `passive|active`。新接受成员采用限制模式；
  创建者可发言。v1 Hub 迁移保留旧发言能力与稳定 ID，数据库版本升至 2。
- `group.policy`：`principalId, operationId, conversationId, targetPrincipalId,
  expectedVersion, role?, speakingMode?`。仅 owner 任免 admin；admin 只能改普通成员发言模式。
- `group.transfer`：同上但无 role/mode；原子转移至活跃成员，旧 owner 变为 admin。
- 本版本移除 `group.reclaim`；旧客户端调用返回 `UNKNOWN_OPERATION`。重新配对不恢复群主或成员资格。
- `message.publish` 可附 `responseToDeliveryId`。被动 Bot 必须携带此字段，且其
  `replyToMessageId` 必须等于相应真实 AI delivery 的原消息。Hub 校验作者、会话、epoch、
  stored 与 revoked，事务性保存唯一回复资格消耗；重复同 messageId 返回原 ACK。
  被动回复中的提及保留显示，但不会触发其他 Bot 的 AI delivery。
- 明确错误包括 `SPEAKING_FORBIDDEN`、`PASSIVE_REPLY_REQUIRED`、`INVALID_RESPONSE_GRANT`、
  `RESPONSE_ALREADY_SENT`、`GROUP_VERSION_CONFLICT`、`OWNER_TRANSFER_REQUIRED`。
  以上授权错误属于终态；离线 outbox 到达 Hub 时按最新权限检查。

通信 Session 的读/列会话/发送/群操作另由宿主限制在其绑定 conversation，不因同一 Bot 身份
而开放其他 DM/群。该执行边界独立于提示词和 UI。原本地群、DM 协议和 DSH 沙盒权限不因此扩权。



## Final review wire requirements

The required membership-epoch capability fences old clients. Every newly committed message and group mutation carries its actor membershipEpoch; retry never acquires a newer rejoin epoch. Byte-identical already committed retries return the original result without new effects. An uncommitted legacy intent lacking scope fails explicitly and remains auditable.

A completed Bot final is tied to exact canonical AI delivery provenance from its own Session turn. Operational cwd context is not an activation grant. New communication Sessions use the verified persona-only public Preset; unfinished legacy standard-preset work is quarantined for operator review.

Publish budgets include complete sync/delivery response containers, the echoed request ID and future sync watermark width. Whole-event pagination counts separators only between elements. Permanently rejected automatic finals retain their stable outbox identity and are visible only in an authorized Human conversation.
