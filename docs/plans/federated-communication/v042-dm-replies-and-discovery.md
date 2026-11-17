# V0.4.2：DM 引用回复与同 Bot 会话发现

## 复现与根因

2026-11-17 报告的两个现象分开处理，不归因于 `work-context` 绑定故障。
使用合成身份与空 SQLite 库，不读取生产消息或凭据。

1. Hub 的 DM 分支仅对主动新消息、显式 activationTargets，以及
   `resumesDmRequest` 识别的首个授权回报生成 AI 投递。
   群的隐含回复对象计算没有用于 DM。仅引用另一 Bot 消息的直接回复会落库，
   但 `ai=0`；有 response grant 的第二轮回复也会漏激活。
   回归在修复前均失败，修复后检查 AI 投递和持久化事件的
   `activatedBotPrincipalIds` 一致。
2. 实际安装的列表工具只筛当前发布 principal，历史工具还包含同 Bot 旧发布
   身份的可读档案。构造十个当前会话加一个旧身份 DM，旧代码稳定返回
   `10 != 11`。此外，列表工具在远程 Session 里还限为当前绑定会话，历史
   工具允许查询自身其它会话。共用自身身份范围消除两种差异。
   这证明了可复现的缺陷路径；没有生产数据库，不能断言报告里的那个 DM
   一定属于旧身份，也不修改现场数据猜测修复。

## 规则与兼容

- DM 的明确引用回复隐含唤醒原作者 Bot；不要求冗余传 activationTargets，
  也接纳旧客户端没有 replyActivation 的消息。群仍按已有能力约定处理。
- 插件对支持 bot-reply-activation 的 Hub，在群和 DM 都声明 implicit，
  系统提示同步说明。旧 Hub 可继续连接，但修复 DM 派发需要更新 Hub。
- 排除作者自身；引用必须属于本会话、在双方入群边界后且目标仍为成员。
  退休/隐藏、成员 epoch、授权校验、去重、因果深度和总激活预算保留。
- collect 请求的精确授权回报继续不唤醒协调者。主动后续提问仍可唤醒。
  明确不回复用 decline_communication_reply；不把普通正文或思考自动发出，
  不按“收到”等关键词猜测是否应启动工作。
- 两个列表共用同 Bot 的 active membership 与旧发布身份可读档案范围。
  不包含另一 Bot 私聊或仅 Human 会话，不恢复已移除成员，不放宽跨会话发送。
  列表是发现入口；具体历史读取仍校验各自 membershipEpoch 与读取边界。
- 既有消息不重写、不自动补派；否则可能把已经处理的旧消息再次唤醒。
  被漏掉的任务需要明确重新发送。无协议或数据库 schema 迁移。

## 验证

Hub 回归覆盖无 grant 引用、带 grant 多轮、事件目标列表、SQLite 重开与重放、
重复 handoff、depth 上限、回复自己、collect 静默回报与后续继续。
实际工具回归对比本地/远程 Session 的会话集合，并验证私聊隔离与发送范围。
`dm-reply-activation-acceptance.mjs` 启动两个隔离 DSH + 独立 Hub + Mock：
连续两次空 mentions/activationTargets 的引用消息进入真实回合、成功提交回复；
检查 stored/ai_accepted、明确不回复控制回执及五条消息总数。
不是对生产现场或真实模型的验收。

验证结果：Hub 226/226；插件 2,301 项，2,296 通过、5 项条件跳过、0 失败；
DSH 0.2.1-rc.4 相关工具/历史回归 18/18；DSH 0.2.2-rc.1 双实例新 DM
验收 3 项与既有显式协作验收 8 项均通过；宿主 Mock 冒烟 52/52。
lint、生成文件 freshness 与 diff 空白检查通过。全部测试宿主已停止。
