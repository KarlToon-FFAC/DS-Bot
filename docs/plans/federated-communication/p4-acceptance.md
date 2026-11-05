# 本机 P0–P4 验收检查点

这是追加权限与最终安全复核前的历史门禁记录。当前结果、真实 Chrome 直接视口复验和修复后的测试统计以
[最终安全复核](final-security-review.md)及[最终证据](final-review-evidence.json)为准。

2026-11-03，实施分支 `chore/federated-communication`，文档基线
`6ede702b7d698a8d86261ecb6a2a5f1efc8e1e87` 保留不变。全部实施修改仍在工作树，
没有提交、推送或部署。此检查点早于用户追加的群主/管理员与发言权限需求。

目标平台为原生 Windows、Node 24.13.0、DSH 0.2.1-rc.4、DS-Bot 0.2.6。
网络只使用本机 loopback WS，模型为确定性 Mock。不同 IP、WSS、NAT、真实模型
和其他操作系统均为 NOT_RUN；本机通过不代表已完成真实跨机器部署。

## 验收与证据对应

| 验收项 | 实际证据 |
|---|---|
| DM-01–05、DM-09 | `behavior-matrix.mjs` 的四方向双向 DM、原生 Bot 工具和并发规范 DM；P2 `adapter.mjs` |
| DM-06、DM-07 | 同 K 的三条 DM canary 隔离；群模型挂起时另一 DM 完成，不 steer 群 |
| DM-08 | Human API 及 Hub 作者绑定拒绝伪造 sender |
| GR-01–06、GR-09–10 | `group-demo.mjs`、行为矩阵、两个真实 Chrome 页面；同名来源标签和实际精确 picker |
| GR-07–08 | 同群确切引用 ID；实际浏览器定位；跨会话引用拒绝；重新加入旧引用占位且不泄露正文 |
| GR-11–12 | 真实群 API 和 Chrome 建群/邀请/接受/移除/退出/解散；默认 Bot 移除后两端切为 mentionsOnly |
| ST-01–05 | recovery/network/atomic 三组独立进程故障测试；浏览器排队、恢复和原消息单份显示 |
| AC-01 | Hub 网络测试：未认证、实例冒用、重新配对、撤销配对、他人游标/回执拒绝 |
| AC-02–04 | 本地 Bot inbox 待消费时撤权，重启不消费；发送者终态 permission_revoked；新 epoch 不复活旧投递/上下文/引用 |
| UI-01 | 两个认证 Chrome 页面、原侧栏、实际 Human DM/群发送、输入保留/刷新/已读、完整操作矩阵 |
| CT-01 | 65399 UTF-8 字节完整传输、附件/超限明确拒绝；浏览器 4000 中文/emoji token 与尾标记完整渲染 |
| RG-01 | 完整插件测试 1455 项：1453 通过、2 原有跳过、0 失败；新 smoke-p4 全 52 步通过 |

故障点逐项对应：FI-01 离线发送者重启；FI-02/03 Hub 提交前/后实际死亡；FI-04
开放 socket 丢 ACK；FI-05/06 接收提交前/后死亡；FI-07 三次及延迟重传；FI-08/09
乱序和缺口阻塞、增量修复；FI-10 A/B/Hub 积压重启；FI-11 injection 前；FI-12 admission
已持久但插件回写前（P2 adapter）；FI-13 admission 前及模型中断后恢复；FI-14 三次重连；
FI-15 重启后直接核对持久记录；FI-16 已持久 final 在 export 前死亡；FI-17 导出事务前/后。

原始脱敏汇总在 [p4-acceptance.json](p4-acceptance.json)。四个脚本分别通过 7、8、11、2
个场景，共 28 个；不把 52 步原有 smoke 或 1437 项原有通过数算作新增功能证明。
通信专项插件单元/交互测试为 22 项，Hub 测试为 21 项。

导出事务中的进程死亡测试使用独立原生子进程、生产 CommunicationQueue 和真实 SQLite WAL，
输入为合成源事件；真实 DSH 的 final/export 边界另由恢复矩阵覆盖，不能混称 DSH 在 SQLite
事务内部被杀。提交前重新打开为三者全无，提交后为全有；重扫复用已提交 messageId。

模型中断恢复保留原输入一次，另发有独立来源的真实重启通知。模型中的失去响应尝试可使总模型
调用数为 2；已持久 final 的恢复不会重新生成回复。不承诺模型工具外部业务副作用恰好一次。

## 界面与包检查

完整浏览器记录见 [P3 evidence](p3-ui-evidence.json)。508/700/1024 宽度用测试专用同源 iframe
加载真实生产页面，实际 iframe 的 viewport/scrollWidth 一致。未将无效的 viewport override
或受工具 guard 阻止的原生窗口操作算作通过，也未绕过 guard。截图已在工具中检查，没有虚构导出图片文件。

实际 tarball 在全新消费目录安装完整固定 DSH，生产插件/runtime/SQLite 均可导入，无 checkout
链接或测试 resolver。Hub tarball 干净安装后 loopback 启动、健康检查与关闭通过。构建一致性、
lint、diff 空白检查通过。临时凭据只在测试进程内存，不包含在证据或发布包里。

运行四个 P4 脚本、group demo 和停止命令见 [本地 runbook](../../../ds-bot/dev/communication/README.md)。
