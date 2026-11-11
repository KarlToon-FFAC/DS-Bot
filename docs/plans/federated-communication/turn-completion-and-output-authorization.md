# 回合完成、可靠回复与镜像输出授权

日期：2026-11-11。调查基线：`1982bec`，Hub / 插件 V0.3.2。

状态：**调研与实施方案，尚未实现本文件描述的 host / Hub 协议重构。**
同批实际代码修复仅为远程聊天引用的颜色。此文修订
[显式外发方案](explicit-outbound-and-dialogue-control.md)中“未发送即可视为不回复”
的假设，并将本地 Bot 回报和镜像网关纳入相同的输出授权模型。

## 1. 已确认的问题

### 1.1 遗漏决策被错误地终结为“不回复”

`runtime.js` 的 `export()` 查询 `completedToolReply()`，将 accepted 映射为
sent、pending 映射为 pending，**其余全部映射为 no_reply**。其余包含：
没有调用工具、只有思考/空正文、以及真正尝试发送但被拒绝。

`queue-store.js::recordDecision()` 随即生成 `noReply` 回执；`replyDeclined()`
阻止后续补发。Hub `store.js` 收到回执后写入 `bot.work.completed` 并关闭该
delivery 的回复授权。因此问题不仅是界面不显示，错误终结还可能让随后正确的
发送无法继续。现有测试确实将“普通 final 自动 no_reply”当成预期行为。

使用现有 `communication-updates.test.js` 的内存 fixture，调用生产 runtime / queue
复现的结果如下；未连接生产 Hub，未读取用户数据：

| 输入情况 | 当前决策 | noReply 回执数 | 本地禁止补发 |
| --- | --- | --- | --- |
| 有 final，未提交任何决定 | no_reply | 1 | 是 |
| 只有 reasoning | no_reply | 1 | 是 |
| 显式 decline | no_reply | 1 | 是 |
| 显式回复待发送 | pending | 0 | 否 |
| 显式回复发送失败 | no_reply，transport=failed | 1 | 是 |
| 显式回复已获 Hub 确认 | sent | 0 | 否（原回复另有幂等保护） |

已实现的 reasoning / text 类型隔离仍然有效；不能为修复可用性重新自动公开
普通 final。缺的是**强制完成契约和正确的失败状态**，而非再加一句提示词。

### 1.2 Bot 回报继承了整轮的用户输出资格

当前本地路径：

1. `handoffs.js::openWork()` 继承父 work 或发送者当前回合的 audience。
2. `turns.js::answerSender()` 在内部答复中携带 rootAudience。
3. `turns.js::userAudience()` 因 `protocol=reply && rootAudience=user`，或父 work
   的 audience=user，将被唤醒的整个回合判成 user。
4. `claimTrigger()` 将这个结论写入 turnAudiences；`feed.js` 的镜像输出筛选读取
   该 audience，没有独立的逐输出授权记录。

用户报告的“12 次 user、3 次 internal”没有完整事件轨迹，本轮不能重建这些现场
次数。代码证明这条继承路径存在；不同父任务可以产生不同标签。
现有 `handoff-results.test.js` 甚至专门验证了委派任务返回后继承 user 的行为。

原设计试图保留“用户要求 A 工作，A 委派 B，B 返回后 A 向用户汇总”的能力。
但它同时让 A 在该回合里的内部笔记获得外发资格。**任务由用户发起，不等于
这个任务中每一段文本都可以给用户。** 单行删除继承会压住泄漏，也会吞掉合法
汇总；只检查 triggerOrigin 同样无法同时解决两者。

另有一个独立且更直接的缺陷：`parts.js` 将 `assistant/message` 中每个 text 块
投影给 feed，`feed.js` 在事件到达时立即输出。现有内存夹具探针中，带 user 标签
的 local-bot/reply 回合在同条消息同时生成 text 和 tool-call，**尚未 turn/end，
`INTERNAL_PRE_TOOL_CANARY` 已进入 user-output SSE**。后续 mixed 输入将标签降级
也无法撤回已外发内容。此前文档对“规范流不含中间步骤”的描述不符合此实现。
只过滤 reasoning 或当前消息的 tool-call 仍不够，之后的 steer 也可能替换正文；
必须等待精确输出提交，再由提交账本驱动镜像。

## 2. 业界机制及本项目采用的部分

以下是官方资料中的机制，不表示这些项目已经实现 DS Bot 的权限或同样的产品行为。

| 来源 | 可借鉴机制 | 本项目的落点 |
| --- | --- | --- |
| [A2A：Life of a Task](https://a2a-protocol.org/dev/topics/life-of-a-task/) | 会话上下文、任务、消息、结果及终态分开；终态任务不隐式重启 | conversationId 不再兼任永久任务；结果关联 task，后续工作明确新建 task |
| [OpenAI Agents：Output types / Forcing tool use](https://openai.github.io/openai-agents-python/agents/) | 结构化输出、工具选择与运行结束可由运行器控制 | 完成要有可校验的决策，不依赖模型记住“还有一步要发送”；不在整个工作阶段强制调用有副作用工具 |
| [AutoGen：Termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html) | 编排器提供状态化、可组合的停止条件 | 一次性等待恢复、任务完成、轮数/时间/预算限制由代码执行 |
| [RabbitMQ：Reliability](https://www.rabbitmq.com/docs/reliability) | 生产者确认与消费者确认分开；确认丢失会导致重传，需要幂等 | 已排队、Hub 已持久化、接收端已持久化、工作完成分别记账 |
| [AWS：Transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) | 业务记录和待发送事件同事务提交，消费者处理重复 | 输出决定与 outbox 原子落库；沿用相同 messageId 重试 |

综合建议：**宿主强制收尾 + 持久提交 + 独立任务调度 + 逐输出受众授权**。
无需引入 RabbitMQ、AutoGen 或替换 DSH；借鉴其契约，复用现有 SQLite、outbox、
inbox 和公开 DSH API。正文关键词、礼貌用语识别、模型自述均不作为协议真值。

## 3. 三条独立状态轴

不能再用一个 `completed` / `no_reply` 同时表达以下三件事：

| 轴 | 示例状态 | 谁确认 |
| --- | --- | --- |
| 工作执行 | admitted、running、waiting_dependency、computed、failed、canceled | 宿主调度器与持久执行记录 |
| 对外决策 | undecided、reply_committed、explicit_no_reply、decision_failed | 宿主校验后的完成提交 |
| 投递 | queued、hub_accepted、recipient_stored、rejected、expired、uncertain | 对应端点的确认或确定错误 |

模型正常完成计算最多证明 computed；异常结束必须保留失败原因。`reply_committed`
证明有待交付的公开内容，不能
证明 Hub 收到了；Hub 收到也不能证明另一 Bot 已处理。只有显式 no_reply 才能
显示“选择不回复”；遗漏、失败、撤权都不能转换成该状态。

```mermaid
flowchart TD
  A[已授权输入 / task] --> B[执行与思考：本地]
  B --> C{宿主收尾检查}
  C -->|已提交回复| D[决策和 outbox 同事务落库]
  C -->|明确不回复| E[仅提交完成控制状态]
  C -->|未提交| F[同任务内有限收尾步骤]
  F -->|有效决定| C
  F -->|仍缺决定或超时| G[显式失败：回复尚未提交]
  D --> H[同 ID 重试并等待 Hub 确认]
  H --> I[可见回复 / artifact]
  I --> J{存在未消费的等待恢复授权？}
  J -->|有| K[恢复原任务一次]
  J -->|无| L[展示，不运行模型]
```

## 4. 宿主拥有完成契约

### 4.1 一份明确的提交

新增一个公共完成入口，概念接口如下（名称是提案，尚未注册）：

```json
{"decision":"reply","publicText":"给当前受众的结果"}
```

```json
{"decision":"no_reply"}
```

`reply_to_communication` 和 `decline_communication_reply` 兼容映射至此契约。
reply 必须有非空且合规长度的 publicText，附件沿用现有校验；no_reply 不能夹带
正文。作者、目标会话、输入 delivery、membershipEpoch、task、root、受众与授权
由宿主绑定，不能让模型通过原始身份/目标参数自由选择。reasoning、普通 final、
工具原始结果不能
成为隐式 publicText。无需要求模型暴露思考过程来证明决策。

唯一键是 `(taskId, recipientPrincipalId, membershipEpoch, outcomeSlot)`。
一次任务最多一个终结决定；新 tool callId 不能绕过此限制。相同决定重试返回
原回执；不同决定竞争返回冲突。进度消息是独立受限操作，不占用终结槽，也不能
凭进度消息让收尾检查通过。提交成功后发生的私密 final 不再改变决定。

### 4.2 正常回合结束前检查

通过公开 `agent/turn-stopping` hook 检查任务账本：

- 有回复提交：允许结束模型计算，交由 outbox 继续发送，不再让模型重做工作。
- 有显式 no_reply：允许结束，发控制状态，不新增聊天正文。
- 没有提交：记为 needs_decision，注入宿主来源的收尾 notice，**最多补全一次**。
  该步骤只允许完成工具；schema 和执行侧同时限制，不能重新运行 Shell、文件写入
  或另一轮派单。notice 明确说明“先前文字没有发送”，不复制思考到公开回复。
- 仍未提交、持续非法参数、模型失败或超时：记 decision_failed，显示
  `COMMUNICATION_DECISION_REQUIRED` 或具体失败码，不能发 noReply。
- 任务正在等已登记的子任务：保留 waiting_dependency，不误判成遗漏或主动沉默。

“最多一次”以原 task/delivery 为单位，而非进程或 Session 回合号。进入补全前
持久化 attempt、noticeId、原始 source、deadline；崩溃恢复核对公开 Session
日志是否已注入，不重新派发原工作。存在不确定性则明确 blocked，不能凭没有看到
回执再次执行有副作用的工具。主动取消、撤权、退休身份、过期 epoch 均停止补全。

一个回合的多个独立输入必须分别建 task 和结算，不能继续用
`completedOutputs().inputs.at(-1)` 代表全部。补充信息归原 task；确需一个结果
覆盖多任务时，宿主逐项验证并原子结算明确集合，不能靠最后一条消息猜来源。
首版收尾阶段由宿主每次绑定一个待决 task；若工作阶段允许并行多 task 提交，
只能使用宿主生成的不透明 outcomeSlot，从当前已授权待决集合选取，并校验其
Session、输入及 epoch。该 handle 只消除歧义，不能创建新授权或改变目的地。

### 4.3 DSH 可行性与限制

[DSH 公开 Agent 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/README.md)
提供正常结束前的 `agent/turn-stopping` 和 steer；本仓
[既有恢复实验](p0-recovery-gap.md)记录了 pinned 0.2.1-rc.4 上使用此 hook。
现有 runtime 的 scoped 工具与来源校验可承接专用收尾阶段，但必须新增原生验收，
尤其是 notice 来源、结束时序、持久化与取消竞争。

不能把当前 DSH master 的新功能当作 rc.4 已有能力，也不能假定所有 provider
支持 strict JSON Schema / `tool_choice=required`。首版依赖插件完成工具、本地
参数校验和完成检查；provider 的结构化约束只是增强。若公开 API 无法覆盖某个
生命周期点，提交上游需求，不能修改 DSH 安装树或偷偷接管其模型循环。

## 5. 提交、发送与回执

沿用 SQLite outbox，增加 `task_outcomes` / `output_commits` 等职责清楚的持久记录
（实际表名在实现时统一）。一次事务写：决策、公开 payload/hash、稳定 messageId、
绑定授权和 outbox。Hub 在自己的一个事务内写消息、结果/终态及投递记录。

断网重试只重传原 ID / 原 payload；Hub 按 ID + hash 幂等。ACK 丢失保留 uncertain
或 queued，由查询/重传收敛；不能换 ID 再生成答案。确定拒绝记 rejected，保留
错误原因；权限/epoch 不符不能自动换身份补发。状态更新与界面只读同一份账本。

显示文案建议：

| 状态 | GUI / CLI 表达 |
| --- | --- |
| computed + undecided | 正在完成回复决策 |
| decision_failed | 回复尚未提交，需要处理 |
| reply_committed + queued | 待发送 |
| hub_accepted | Hub 已接收 |
| recipient_stored | 对端已收取 |
| explicit_no_reply | Bot 选择不回复 |
| rejected / expired / canceled | 发送失败 / 已过期 / 已取消，附具体原因 |

模型声称“已发送”不改变状态。可查询提交结果；网络待确认时无需让模型无限等待。
重试按钮重试投递，重新执行按钮创建明确的新任务，两者不可混用。
这实现可恢复的至少一次传输与幂等逻辑效果，不承诺所有外部 Shell 副作用 exactly once。

## 6. 发布消息与运行模型分离

Hub 显式保存 task/subtask、父任务、root、等待者和一次性 continuation grant。
每份授权绑定主体、会话、epoch、task、失效条件；由可信宿主/Hub 创建，不由正文
或模型声明 `kind=result` 获得。

| 消息/操作 | 展示行为 | 调度行为 |
| --- | --- | --- |
| request | 展示请求 | 有授权才建目标任务并激活一次 |
| result | 展示已提交结果 | 只可消费对应子任务的一次性等待恢复授权 |
| notice / 进度 | 可展示 | 不创建任务、不自动唤醒 |
| ACK / no_reply / failed 控制状态 | 更新状态 | 不生成聊天/确认链 |
| 显式 follow-up | 展示新问题 | 在同一 root 下建下一任务，检查剩余预算 |

任务调度器可在依赖任务以 result/no_reply/failed 结束时，按原等待策略恢复父任务
一次或直接结算失败；这是已登记依赖的完成，不是控制消息自己给任意 Bot 新派单。
并行多个子任务使用明确 all/any 策略并原子消费恢复授权，不能每来一条状态都跑一轮。

DM 与群使用相同机制。`replyToMessageId` 只表达引用，`mentions` 只表达选中成员；
它们本身不等于可无限调用的权限。普通 Bot 回答不广播给群默认接收列表。
群中多个默认 Bot 各有自己的 task 和 outcome，不以抢到同一个完成槽的方式工作。

例如 A 请求 B 校验结果：B 提交 result，A 原任务恢复一次；A 给用户或群提交最终
结果，不再激活 B。若 A 确实有下一项工作，则显式发起 follow-up。是否继续合作
由任务操作决定，不通过“谢谢”“收到”之类自然语言猜测。

已有 depth 8 / root 32 默认限制保留为保险，同时补 deadline、fan-out 和主体新根
速率限制。子任务和 follow-up 不重置 root 配额；长期 DM 不永久共用 genesis 根。
新根只由明确的本地用户/调度任务或已授权的主动工作策略创建，远端执行工具不能
省略 cause 冒充新的本地请求。预算耗尽明确显示“消息已保存，目标未被启动”和
具体原因，不能用一个 success 掩盖唤醒失败。

## 7. 镜像使用逐输出授权，不继承整轮可见性

### 7.1 保留任务来源，分开公开资格

`rootAudience` 可保留用于溯源，但不能再作为允许镜像的布尔授权。
区分：

- **work_result**：发给发起任务的本地 Bot 的内部协议结果。
- **user_reply**：明确提交给绑定的用户会话的公开结果。
- **remote_reply**：明确提交给绑定远程会话的结果。
- **private_note / reasoning**：只留执行日志。

local-bot 的 reply 输入始终是内部协议输入；返回结果可唤醒原先的用户任务，
但不能把该回合全部文本升级为 user。恢复授权只允许继续执行；公开授权绑定
特定输出和目标，是另一个动作。

正常流程仍成立：用户 U→A→B，B 的 work_result 只给 A；A 处理结果后通过受约束
的 user_reply 完成提交，宿主检查 U 原任务与目标绑定，形成新的公开输出。
若 A 仅写内部笔记，则不镜像；若忘记提交真正给 U 的汇总，走同样的有限收尾检查，
不会在防泄漏之后又悄悄吞掉用户答案。直接用户聊天可以保留其明确用户输出路径；
异步 Bot 返回、混合输入及恢复回合不得沿用整轮自动公开。
直接用户 answer 也应在正常收尾时由宿主验证本轮始终拥有唯一用户目的地，再正式
生成 output commit；不要求普通用户聊天额外调用发送工具，也不提前镜像中间正文。

`handoffs.openWork()` 应继承 task/root/parent 的身份，不继承“全部正文可见”权限。
`turns.userAudience()` 和历史投影改为查询输出提交记录。对于同轮用户与 Bot 输入，
逐输出绑定原任务；不能让最后到达的输入决定前面所有内容的受众。

### 7.2 镜像出口契约

现有 `/api/bot/user-output` 应演进为只发已提交 `user_reply` 的规范事件，至少带
outputId、commitId、sourceTaskId、origin、outputKind、目标会话/绑定、payloadHash
及持久游标。服务端校验提交记录与目标权限，不能只查 `audience=user` 标签。

网关只消费规范事件，按 outputId 去重、保存游标并确认已推送；不能订阅原始 DSH
assistant final 或读取内部 work_result 后自行推测目标。重连从已确认游标补投，
Hub 控制回执不进入用户聊天流。不存在匹配绑定的输出只保留本地并报诊断。

外部接收人映射由网关持有时，网关也必须校验 Bot/会话与其登记的用户绑定；插件
不能凭一个 botId 证明网关最终发送给谁。需要对应适配器共同升级。
还需核实外部平台是否支持稳定 outputId 的幂等发送或结果查询：平台已接受、网关
确认尚未落库时崩溃，单靠本地去重不能同时保证不丢且不重。没有平台侧支持时必须
记录 uncertain 并对账，不能将 SSE 消费确认或平台接受等同于手机用户已经收到。
**WeLink 网关代码不在本仓库，本轮不能宣称其已修复。** 当前版本的 SSE 只是
实时过滤流，没有持久补投/确认；这些是本方案待建设的内容。继续读原始 Session
日志的旧消费者仍能读到内部正文，不能靠 UI 隐藏保证安全。

逐输出授权保证路由边界，不证明远端内容真伪，也不能语义保证模型显式提交的
每个字都适宜披露。原有最小数据暴露、工作权限和敏感披露审批继续独立执行；
此前暂缓的 D4 证据真值问题不在此处暗中扩项。

## 8. 迁移与实现顺序

新增能力按协议协商，例如 `task-outcomes-v1` / `output-commits-v1`，名称待最终实现
统一。GUI 或文案更改不增加协议门槛；不靠 Vx.x.x 相等判断能否通信。
新任务语义必须同时检查 Hub 与参与客户端能力，旧客户端不能被当成已经遵守它。
兼容模式显式说明限制，不能悄悄回退成自动 final 外发。

历史隐式 no_reply 已经关掉的授权不能自动复活，也不能扫描旧 final 批量补发。
对能辨别的旧隐式决策显示“旧版隐式结束”，人工重做是新任务；无法辨别则记录
legacy/unknown，不推断原意。新的 gate 只作用于升级后登记的任务。
旧 pending 的显式发送保持原 ID 恢复；旧自动 export 继续隔离。
镜像旧游标以前未授权的正文不能在迁移时作为用户输出补播。

建议按以下四个可独立验收的提交组落地，不在每个提交自动刷版本：

1. **完成状态与宿主 gate**：修正 `runtime.export`、queue 决策与 rejected 状态；
   注册 turn-stopping；来源/工具限制、持久补全预算、GUI/CLI 失败可见性。
2. **输出事务与任务协议**：Hub 原子 outcome、task/continuation、DM/群统一恢复、
   activation 结果与能力协商；复用现有 outbox/inbox。
3. **本地输出与镜像**：替换 handoffs/turns 的隐式 audience 权限继承；输出提交表、
   user_reply 完成入口、规范 feed 的持久游标与确认；外部网关单独对接。
4. **迁移和端到端验收**：新旧组合、崩溃窗口、真实模型遗漏工具，以及失败提示。

每组都必须保持 reasoning、远程及异步/内部执行的普通 final 本地，禁止默认唤醒回路。
直接用户 answer 依上一节的正式提交规则处理。只改提示词、
自动转发所有 final、仅删除 audience 继承，均不能作为这份方案的完成标准。

## 9. 必须通过的验收

| 场景 | 验收结果 |
| --- | --- |
| 模型只写“已回复”，漏掉提交 | 同任务有限补全后一次公开回复，或明确 decision_failed；绝不隐式 no_reply |
| reasoning-only / 空 final | 不外发；进入明确决策路径，不猜主动沉默 |
| 显式不回复 | 一个终结状态，零聊天消息、零确认链 |
| 显式提交后又写私密 final | 只发提交文本，私密 canary 不进任何公开出口 |
| 待发送 / 确认丢失 / Hub 拒绝 | 状态准确，不变 no_reply、不重生成答案 |
| 提交前后、发送前后、ACK 前后崩溃 | 同 ID 收敛；无重复消息、完成或 AI 激活 |
| 漏工具持续发生 / 参数反复错误 | 持久预算耗尽后失败；重启不补充预算 |
| 同回合多输入 / 新补充 / 两端同时发起 | 分任务、分授权，无 at(-1) 串源 |
| request→result→ack | 只恢复预登记等待者一次，ack 不唤醒 |
| 有用的后续问题 | 显式下一任务可执行，仍沿用原 root 预算 |
| 多 Bot 默认接收 / 群内并行子任务 | 各自结算；父任务按等待策略恢复一次 |
| 已退休 / 撤权 / epoch 改变 / 用户取消 | 不重试模型、不自动换身份；显示具体原因 |
| 用户→A→B→A 汇总 | B 的内部结果不镜像；A 提交的 user_reply 正常到用户 |
| 内部 Bot→A，发送者恰好在用户回合中 | 内部正文不因祖先 audience=user 外发 |
| 混合输入、重启、历史投影、旧标签 | 无授权输出记录即不镜像，不因回放恢复旧权限 |
| 工具调用前正文 / 随后被 steer 替换的正文 | 提交前不进入 SSE；后续标签变化不造成已外发内容无法撤回 |
| 网关断线补投 / 重复事件 / 错误接收人绑定 | 去重、保留游标、错目标拒绝；受测适配器不再订阅原始日志 |
| 外部平台接受后、网关确认前崩溃 | 有幂等/查询能力则收敛，否则保留 uncertain 并进入对账，不虚报已送达 |

先用两个真实隔离 DSH + 自有 Hub + Mock 注入上述失败，再用真实模型测试“只写
final”“写谢谢”“误称已发送”等行为；判定依赖 Hub 消息、任务账本、激活次数
和镜像出口，不能依赖模型口头自证。真实模型测试需要实际可用的授权测试凭据；
本次调研没有运行真实模型或生产网关。
