# 对话链情景推演

[打开交互图](index.html) · [设计说明](../conversation-chain-model.md)

[查看完整图示例](overview.png)

这是文档配套的固定脚本推演，不是产品界面或协议实现。可将 `index.html` 下载后
用浏览器打开；所有数据、样式与脚本都在一个文件内，不调用网络或模型。
若浏览器禁止直接打开本地 HTML，可在本目录用自有本地静态服务查看。

选择场景后默认展示完整图；拖动步骤条或点击播放可以观察各分支如何出现。
“原尺寸”用于读文字，“适配宽度”用于看完整形状；窄屏可以横向滚动。
“只看群消息”保留公开节点及它们的引用边，隐藏演示用的本地执行与控制节点。
这只是虚构数据的讲解筛选，真实产品必须在服务端阻止私密节点进入群 API。

`scenarios.json` 是十个场景的唯一数据源。修改数据或模板后，在仓库根目录执行：

```sh
node docs/plans/federated-communication/conversation-chain-explorer/build.mjs
node docs/plans/federated-communication/conversation-chain-explorer/build.mjs --check
```

构建时校验节点、参与者、枚举、泳道重叠、边引用和因果时间方向；`--check` 另校验
生成文件一致性。`visualization-checks.json` 记录浏览器中的十场景逐步回放、节点详情、
群消息筛选、自动播放及 390/768/1440 像素窗口检查，控制台无错误。

以上只验证可视化工件。**没有运行 DSH、Hub、真实 LLM、网络故障模拟或 Shell 副作用
测试；不能据此宣布新协作协议已通过验收。**
