# V0.4.0：当前本地回合显式写给用户

版本保持 V0.3.9，等待统一发版。

## 判定和范围

turnAudiences 是插件自己的受众记录。统计里的 user + local-bot 不一定是串台：
用户任务委派后的结果回到原请求方，原有根任务 audience=user 会使该结果回合正常
面向用户；纯内部请求、远端来源和混合内部输入保持 internal。因此不修改既有四类
受众判定，也不依据正文文本猜测受众。新增入口补足“接收方主动声明”的能力。

新增无参数工具 publish_turn_to_user：宿主取当前执行 Session、活跃 turn 和真实
工具调用 ID/事件 seq，不接受外部指定 recipient、Bot 或历史 turn。仅当前本地
Bot 私聊的 Bot 触发回合可从 internal 显式选择 user；已有普通 user 回合返回
already_user，不改 ledger。

## 正文边界

调用者必须先调用工具并确认成功，再写给用户的普通正文。只设整个 turn 的 user
标签会使此前内部正文经历史重读被公开，因而 ledger 额外记录 userOutputFromSeq：

- audience=user、explicit=true、baseAudience=internal；保留原始 triggerOrigin/protocol。
- explicitCallId 及 fromSeq 绑定宿主观察到的调用；仅 fromSeq 后的 text 块公开。
- 不公开同一 assistant 消息内、工具调用之前的正文；不公开 reasoning 或工具结果。
- 旧 exchangeTurns 标记保留：只有通过完整显式授权校验的正文能够越过它。
- 没有有效 seq/边界、标记格式不完整、保存未完成或失败时不放行。
- 重复调用返回同一决定，不能移动起点来补发早先文本。
- 下一回合、跨分段继续、被委派工作都不继承本次 explicit 权限。
- 中途收到远程来源时结束授权区间，记录 throughSeq；此前已公开部分继续可见，
  后续内容保持内部。待保存期间收到远程来源则整次标记失败。

这是“从现在到本回合结束的正文意图”，不是精确某条消息的重发工具。误写过的
内部正文不会补发；如果想把之前的草稿给用户，应在标记成功后明确写出适合用户
的版本。对方 Bot 的正常内部请求回执仍走原工作图，避免转向用户后请求方永久等待。

## 远端和权限

远程 Session、带 remoteSource 的本地咨询、federation-report、收到远程输入的
混合回合均拒绝，并返回 TURN_PUBLICATION_REMOTE_SOURCE。群会话及自动 handoff
不支持此入口；群输出有自身渠道。只读宿主、过期调用、无活跃 turn、保存错误都有
明确失败，绝不返回“已经推送”。本机工具权限和对外敏感信息边界保持不变。

## GUI、feed 和 WeLink

原生 AssistantCell、parts.displayItems、流式正文和 /api/bot/user-output 共用显式标记校验；历史读取
不能只看到 explicit=true 就放行。普通 user 及未标记 internal 保持现状。
GUI 通过 turnPublications 读取授权区间，保存中的标记不展示；保存完成即便团队
revision 不变，也会更新 liveKey 并刷新可见性。工具和思考单元仍按内部回合隐藏。
侧栏摘要、全文搜索和导出仍保守沿用旧的内部回合过滤，不扩大本次正文公开范围。
user-output 中逐条 item.routing 带 audience=user、explicit=true、原始来源与
授权区间，outputId 继续使用原事件 seq 和文本块 index，供镜像方去重。

WeLink 网关不在本仓库。此次真实宿主验收覆盖规范 user-output SSE，没有调用
WeLink 服务；接入此 feed 的镜像能获得这些正文。仍读取原始 DSH 日志或自行仅按
triggerOrigin 过滤的外部网关，需要按受众与显式授权契约适配。这个 feed 是实时流，
不提供外部送达确认；不得把工具返回 enabled 描述为 WeLink 已送达。

## 验证

- 本地 Bot 请求 → 标记 → 用户正文：保存正确，GUI/feed 可见，原内部请求仍收到答复。
- 标记前普通正文、reasoning、五个历史 internal 回合、下一回合继续隐藏。
- 普通用户委派结果、reply_to=user 及混合输入默认判定回归不变。
- 无当前真实调用、远程、群、只读或存储失败拒绝；并发重复调用不先返回成功。
- 保存中不公开；远程输入中断不扩大边界；后续委派不继承显式授权。
- 真实 DSH + Mock：公开报告 → 未标记内部报告 → 新公开报告，核对持久 ledger、
  用户聊天和 user-output SSE，只收到两条明确公开的报告。

### 本次验证结果

- 插件全量：2201 项，2196 通过，5 跳过，无失败；之后新增的同 revision 状态更新测试所在 roster 套件 50/50 通过。
- 原生宿主冒烟：52/52 通过；构建一致性检查和 lint 通过。
- 隔离 DSH + Mock + Chromium：未刷新页面即显示两次显式报告，内部对照隐藏，浏览器无异常；规范 user-output SSE 收到同两条报告。
- 可复跑：`node dev/communication/turn-user-publication-acceptance.mjs`。设置 `DSBOT_PLAYWRIGHT_MODULE` 与可选 `DSBOT_CHROMIUM_PATH` 可同时验证原生浏览器；测试使用专属目录和端口并自动停止进程。
- 未连接真实 LLM 或 WeLink，未改动用户数据，未升级版本号。
