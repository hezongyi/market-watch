# Issue #75：系统中心与交易告警分流验收

2026-10-19。当前生效约定见[用户确认合同](../../notification-ui-contract-20261019.md)。本记录取代旧版混合中心/通知侧栏的界面验收；[旧 R2 记录](../unified-notifications-20261018/execution.md)仅作为未改变的持久接收、迁移、来源与手机协议底座证据。

本次增量 **F0 / Ubuntu R1**：兼容查询、有界系统已读 API、展示分流与原生控件复用；无 schema 变化。PR 整体新增的持久后台底座仍按 F1/R2 的原证据和 CI 检查，不能把本次 R1 宣称为重新完整验证底座。

## 环境与运行

- 本机：`quant-server / Ubuntu 22.04.5`，独立 Docker task/project `mw-issue75-v2-20261018`，不是 SSH 转发服务。未操作 Unraid。
- 验收：<https://192.168.7.232:18280/advanced-charts/mw75-a>；图表来源：<https://192.168.7.232:18281/>。
- 自签名证书；浏览器必要时先分别接受两个来源的证书。密码沿用本任务既有验收密码，通过对话单独交付，不进入仓库。
- 私有配置：`/home/quant/repos/.mw-issue75-v2-tool-state/runtime/`。本次 UI clean run 使用同任务 PG14.24 的 `preview_mw75_ui20261019` 数据库；旧 clean run 和负载测试库均保留。真实外部手机投递关闭。
- 启动：`python3 /tmp/mw75-ui-compose.py up -d --no-build postgres api projector web chart gateway`。该任务 wrapper 使用私有 compose.json、final-override.json、ui-override.json；配置和凭据不入库。
- 重建 API 后需 `python3 /tmp/mw75-ui-compose.py restart web`；重建 web/chart 后需 `python3 /tmp/mw75-ui-compose.py restart gateway`，让 Nginx 重新解析容器地址。重启间的短暂 502 不作为产品行为证据。
- 停止：`python3 /tmp/mw75-ui-compose.py stop`；不删卷、不删除数据库。
- API/projector 768/384MiB，PG512MiB，Web/Chart96MiB。最终镜像见 [runtime-images.txt](runtime-images.txt)，构建统一使用安装的 mw-docker、`market-watch-ubuntu` builder、purpose=acceptance。镜像从待提交源码构建，不能声称构建时工作树 clean。

## 实测结果与范围

Playwriter CLI session 2 驱动本任务 Chromium 153，HTTPS、1440×1000、850×900、390×900。结构化记录见 [playwriter-results.json](playwriter-results.json)。图表使用真实许可 v31.1.0 库与任务 D1 合成历史；没有修改许可库字节。

| 约定 | 证据 |
| --- | --- |
| 通知中心只含系统消息，列表/中文搜索/过滤/未读均分流 | 实际 API `audience=system` + 界面搜索交易标题为空；中文搜索恢复事故只返回一条，含累计2次。原生菜单键盘 End/Enter 和 Select 选项点击通过 |
| 交易告警只在现有右侧模块 | 真实 create/consume 服务接受合成观测，经过 Audit/projector/runtime；即时卡点击选中对应 `data-signal-id` 日志，未打开系统 popup |
| 唯一顶部即时卡与操作隔离 | 两类卡均 x542.5/y46/w355，水平中心误差0，距38px工具栏底8px；没有原 `.mw-chart-notice`，没有 aria-modal=true；稳定工具栏控件焦点保持；卡片外 Escape、拖拽和滚轮缩放有效 |
| 通知中心不改变布局 | 图表矩形打开前后均 x56/y42/w1034/h877；原生 page 列表仅 base/alerts/data-window/object_tree，无通知 page |
| 普通 info、重复和恢复 | 受控事件走真实接收/投影；重复只累加事故次数，恢复关闭同一事故，无额外卡；Runtime 对普通 info 有回归断言 |
| 系统开关不抑制交易 | 系统关闭后记录可查询而不弹；刷新保持；关闭期间新交易仍经过同一即时卡进入告警日志；开关跨同源标签同步另见结构化记录 |
| 已读与手机隔离 | UI 全部已读后 system_unread=0，交易 viewed/handled/channels 前后相同；后端验证固定水位、新到记录不读、100条事务边界、事故范围、epoch拒绝、phone ack/outbox不变 |
| 深链兼容 | 旧 `/signals?signal=` 和 `panel=notifications&event=s:...` 均转至 panel=alerts、保留目标 signal，选中相同实际日志；系统中心未打开 |
| 主题、窄屏、侧栏避让 | 浅色中心背景白/正文rgb(19,23,34)，深色恢复；850/390非模态中心未越界；850打开自选表时即时卡水平居中、右侧距表8px，390即时卡位于视口内 |
| 父页面降级与恢复 | 阻断 `/native-alert-shell.js` 时父页面仍能查同一系统记录；取消阻断刷新后父页面入口/中心消失，仅原生入口存在，无重复浮窗 |

单独后端结果：[系统中心26通过](backend-system-tests.txt)、[关联31通过/7跳过](backend-related-tests.txt)；上述跳过中6项真实 PG 专项已在本任务 PG 的随机临时 schema 单独执行，[6通过](postgres-tests.txt)，另1项需外部配置的集成检查未执行。测试 schema 按测试 fixture 自建并删除，没有修改本任务业务表。

本次修复了角标重建丢焦点、原生菜单被自定义层遮挡、过时排队消息弹出、中文 JSON 转义搜索漏查、中屏卡片遮自选表、旧事件跳转丢目标参数。新增断言针对这些行为；TypeScript、Runtime Node、导航 Node、Ruff 与 diff 检查通过。最终 required CI 以 [PR #87 checks](https://github.com/hezongyi/market-watch/pull/87/checks) 为准，提交证据时不把运行中检查写成通过。

## 截图

- [系统即时卡](system-final.png)、[系统中心](center-final.png)、[交易即时卡](trade-final.png)、[交易告警日志](trade-log-final.png)
- [浅色](light-final.png)、[850中心](850-final.png)、[390中心](390-final.png)
- [850卡片避让自选表](850-card-final.png)、[390卡片](390-card-final.png)、[父页面降级](fallback-final.png)

## 自审与边界

本次按 F0/R1 做[本人自审](self-review.md)，不冒称旧 Standards/Spec 报告已复核当前 UI。检查了强制 system audience、同事故分页与原始发生保留、有界水位已读、原生 page=null 不改侧栏、父/原生互斥、卡片不抢焦点、唯一队列与手机状态隔离。旧报告只适用于它们注明的源码范围。

即时卡 `NoticeBubble` 外壳为自定义非模态容器；原生 Button、InputControl、Select、Checkbox、PopupMenu/PopupMenuItem 均通过既有固定版本适配器复用。深浅主题读取图表弹层变量并有回退颜色；不能称整个卡片是图表库原生 toast。用户主动设置/表单、输入校验、草稿恢复/丢失确认继续保留；旧主页主动通知/声音退役，历史与手机停止协议保留。

受控 BrowserEvent 用于焦点/合并/开关等界面边界；交易调用真实告警服务但输入为合成观测，不声称真实市场触发或手机送达。实际原生保存失败在该隔离实例通过503故障注入验证过；保存暂停和本机草稿保留属于既有保护，未用后续被阻止的保存冒称恢复成功。不声称物理听见、真实读屏设备、全部浏览器或长时间性能压力已测。

没有合并 main、正式 Git/Docker tag 或生产发布。验收实例继续运行供用户检查，不退役进行中的任务资源。
