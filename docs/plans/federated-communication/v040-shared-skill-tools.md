# V0.4.0：本地与远程统一记忆和技能工具

本批次版本保持 V0.3.9，等待用户发版指令。

## 原因

read_own_skill/save_own_skill 实际调用本地 capability 库，却在 communication.js
注册，由远程包装先检查 Hub 配置、发布身份及投递来源。于是未发布本地 Bot 看见
两套工具，调用“自己的技能”反而收到 BOT_NOT_PUBLISHED。两边数据本来相同，
缺陷在工具归属、额外门禁及过时提示词，不需要数据迁移。

## 统一后的入口

| 操作 | 本地和远程共用入口 |
| --- | --- |
| 普通长期记忆 | recall / remember / forget；原有 own、team、group 及私有 Bot 权限 |
| 列出能力 | list_capabilities |
| 读取 Skill 全文、pack 列表或 MCP 摘要 | read_capability；不返回 MCP 连接凭据 |
| 创建/更新 | save_capability；Skill 使用 kind=skill，attach=true 同次保存挂到自身 |
| 挂载/卸载 | attach_capability / detach_capability |
| 删除共享条目 | delete_capability |

注册到本地团队工具，远程只复用同一个定义和 selfOf 身份解析。远程执行仍先检查
当前会话成员资格，避免撤销成员后利用旧工具继续执行。本地操作不启动 Hub，
不开启远程功能也能使用；普通 Bot 无权修改其他 Bot 创建或使用中的共享技能，
原本的 Main Bot 权限不受远程“自己技能”附加限制影响。

保存附带自身挂载在同一次状态保存中进行，不先回报成功再单独挂载。默认省略
attach 时保留原挂载，不强制给所有能力自动挂载。失败的权限或参数检查不挂载。

旧 read_own_skill/save_own_skill 仍可处理旧会话产生的调用，但不出现在新模型请求
的工具列表和独立工具提示段中；只转接同一个本地实现，返回新入口提示，失败
说明本地权限原因，不建议发布到 Hub。旧 save_own_skill 保留保存并挂载的行为。

能力库原本是团队共享库，挂载列表代表启用，不是私有副本。read_capability 可读
库中已保存的 Skill；这与各 Bot 本来能自行挂载任意共享技能一致。私有资料应留在
工作目录或有权限边界的 Bot 记忆中，不能依赖“未挂载”充当共享库的保密权限。

## 保留的不同入口及原因

1. 文件型 Skill/AGENTS.md 与共享能力库：两者是不同存储和发现机制，不是本地/远程
   副本。文件有工作目录、继承层级及沙箱规则；自动迁移会改变生效范围。继续使用
   原生 Skill/file 工具，库中读不到时明确提示此区别。远程使用该 Bot 同一工作目录。
2. remember_communication_relationship：按 Bot、Hub、会话、membershipEpoch 和
   真实 sourceMessageId 保存归属、组织、特长等关系证据。不能当作普通 remember，
   否则会丢来源、成员撤销边界及冲突信息。失败响应提供普通记忆/技能替代入口。
3. read_own_chat 与 read_own_remote_history：本地 DSH 消息 ID/分段索引与 Hub 消息
   ID/成员 epoch 是不同地址空间。保持明确入口，远程历史失败提示本地历史入口。
4. consult_local_bot/report_to_local_chief：是有原远程输入绑定及内部回执的协作流程，
   不属于记忆或技能副本，不替换本地 message_bot。继续保留 V0.3.9 的本地答复通道。
5. 远程 localMemory=false 及全局 memory=false 是用户明确选项；不能因归并悄悄解除。
   普通记忆仍只有一份，远程未启用时不暴露普通记忆工具。

## 提示词与验证

两种会话使用同一段工具规则；修正内置 dsbot-team/dsbot-remote Skill 中仍宣称
远程无法使用本地团队工具的过时文字。对外发送仍需显式操作，记忆/技能修改不自动
产生远程消息。普通记忆保留远端来源元数据，远程声明不能变成本机用户授权。

回归覆盖：未配置 Hub/未发布本地 Bot、新旧工具互通、远程写本地读、本地写远程读、
单次保存挂载、重复挂载、创建者/Main Bot/共享使用权限、只读拒绝、成员撤销、
真实 DSH 模型工具目录不展示旧名、MCP 敏感配置不进入读取结果、双 DSH + Hub +
Mock 的记忆/技能/AGENTS.md 更新与原本本地咨询路径。

本轮验证结果（2026-11-13）：插件全量 2193 项，2188 通过、5 跳过、0 失败；
追加诊断回归 21/21；真实 DSH 双实例 Mock 验收的未发布技能、共享上下文、精确
本地消息读取、双向咨询四项通过；宿主冒烟 52/52；lint、构建一致性和 diff 检查通过。
测试仅使用隔离测试目录与 Mock，无真实模型密钥或用户数据。
