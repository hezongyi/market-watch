# 通知第 13–21 项集中实现与验收

第 13–21 项共九项已完成实现、独立审查和 `$mw-acceptance` 原长期实例业务验收。产品提交 `b32c2f82da82f0a8c8a8b662f692e5334c3a0b97`；最终产品 CI 已通过，文档归档提交另核对最新 PR checks。

风险：F1。修改共享行情 worker→可靠来源→投影链路、浏览器观察闭环和偏好并发；无数据库 schema 迁移。沿用现有 JSON 格式，新增字段兼容旧客户端；必须完成独立 Standards / Spec review、兼容回归和 Ubuntu 实机验收。

| 项目 | 实现与关键验证 | 实例验收 |
| --- | --- | --- |
| 13 原生指标模板 | 开启原生 Templates，仅隐藏重复 Indicators；既有 adapter 存储、许可文件未修改 | 保存/应用/取消与确认覆盖/删除/刷新/跨工作区/多窗口均通过。双图非激活 MA55 保留，激活图应用 MA21；删除后指标保留。只读零写入并有原生未保存提示 |
| 14 共享故障 | fenced commit 可靠主来源、任务去重、影响证据、安全错误链、短抖动抑制及旧 JS 保守兼容 | 部署后两个任务各失败并恢复，各投影一条主事故；其中一任务影响 3 个订阅仍仅一条。兼容及安全回归通过 |
| 15 偏好冲突 | revision/已观察基线/本地意图分离，三方合并、有界冲突处理、删除保护 | 真实 API 两窗口冲突拒绝、同值 revision 不增长、删除不复活。模拟失败只写一次、未落库且原生显示“设置未保存”；成功分别恢复、迟到 scope 隔离回归通过 |
| 16 观察闭环 | HTTP/SSE 同 owner；失效世代不恢复；取消/替换/退出为 ended | bridge 顺序、真实 Chrome reload、离线有序结束、故障提交后阻塞 claims 再立即退出均通过；fault+退出 intent 同 IDB 事务 |
| 17 连接分类 | transport/registration/market 分开；422 不重试、暂时初次失败退避、同 client 聚合 | 实际 producer 与 bridge 回归通过；onopen 不恢复注册/供源，实际服务端主事故见第14项 |
| 18 重试及隔离 | 读取共享在途与有界退避；仅加载错误单次 chunk 重试；acceptance_run 分组 | 读取/chunk/后端隔离回归通过；新候选原生及模板懒加载可用。使用自己的页面、工作区、故障名称与标识，不删除历史 |
| 19 历史重开 | controller 缓存完整加载页、筛选排序和滚动；先缓存后刷新；首次占位；批量事故查询 | 新请求暂缓时仍显示 100 行并恢复 scrollTop=600；首次不误报空；503 终局失败留行并显示错误。筛选保留，上海 UTC+8 且原 instant 不变。实测 7 SQL/1 事故查询（原107） |
| 20 分隔线 | 整合 `85af0d7` 为 `96b487a`，只隐藏入口前一线 | 浅色另7线、深色760px另5线保留；目标 wrapper 9px、键盘入口、刷新与新 controller 均通过 |
| 21 系统浮窗 | 系统 CTA 及空操作区移除，交易必须确认保留 | 实际系统仅 X；X/3秒自动消失后 viewed/handled 仍 null。同生产 renderer+隔离 transport 的合成交易保留定位/记录/确定、无 X且不超时，无真实交易传输 |

独立 Standards/Spec 最终均通过。返工包括连续偏好保存、旧 JS 保守归属、旧 epoch 顺序、页面退出原子 intent，以及实际 UI 发现的旧错误通道吞提示。偏好所有公开写入口统一报告最终结果、成功明确恢复、保存/删除分别归属，并在入口捕获 scope 防止晚到回调污染新工作区。

验收实例固定为 Ubuntu `quant-server` / Compose `mw-issue75-v2-20261018`：应用 `https://192.168.7.232:18280`，图表 `https://192.168.7.232:18281`。2026-10-20 09:42 UTC 只读核对：15 服务运行，API/PG healthy。保留真实数据、认证/数据源配置、原卷、网络/TLS/origin 与保护浏览器；新测试使用自己的页面/工作区与显式标记。不合并、不发布生产、不删除历史样本或确认真实交易。

证据：[浏览器结果](browser-results.json)、[实际运行及配置保留](running-audit.json)、[部署后只读数据库核验](deployed-readonly-results.json)、[测试结果](test-results.json)、[独立审查](code-review.md)。

实拍：[原生保存](01-native-template-save.png)、[覆盖确认](02-native-template-overwrite.png)、[首次占位](03-history-first-loading.png)、[请求暂缓时缓存](04-history-reopen-cached.png)、[刷新失败保留列表](05-history-failed-refresh.png)、[系统浮窗](06-system-bubble.png)、[明确未保存](07-template-unsaved.png)、[合成交易对照](08-synthetic-trading-bubble.png)、[只读拒绝](09-native-readonly-unsaved.png)、[筛选和时区](10-history-filter-timezone.png)、[深色窄屏](11-dark-narrow-divider.png)、[激活图格](12-template-active-chart.png)。首轮图来自 c1；返工相关 05、07、09–12 来自最终 c2，早期图保留真实时间。

缓存暂缓请求测试证明列表不依赖新响应；繁忙共享主机一次完整原生缓存首帧约906ms，不声明固定开窗时延 SLA。100行只读数据库复测约102/95ms（此前冷/热711/41ms），均7 SQL/1次事故查询，不能将这些单次时延当通用保证。完整加载多页、highwater/epoch/重复游标、账号/controller和旧请求隔离由真实 React mount/unmount 回归补充。

## 实际运行版本与运维

15个长期服务运行，API/PG healthy。实际 Docker image ID：

| 组件 | 固定镜像 | Image ID |
| --- | --- | --- |
| API及十个worker | `market-watch-api:notice1321-20261020-c1` | `sha256:cf441c424eb2afda9ec1c7cad4fb3dc97645b1e7ff45fc361d30ee7e2682bd20` |
| Chart | `market-watch-chart:notice1321-20261020-c2` | `sha256:d26e7e2fdd3ee832636dff1d259dd0390349e5a674e1b2ae3278f3d2706732f6` |
| Web | `market-watch-web:notice1321-20261020-c2` | `sha256:49aca302e735d91c0734eaed988d45932acd4de38d7668e79ae3b75203f86982` |

API来源 `104e8db`，后续产品仅改Web/Chart，c2来源 `b32c2f8`。构建时保留既有未提交文档，标签为dirty=true；产品代码已提交固定，不把HEAD单独当作所有构建输入证明。使用安装版mw-docker、原market-watch-ubuntu builder和task/project/purpose标签；沙箱仅重定向可写工具状态、保留原全局lock，未修改HOME或安装工具。

全部13个应用服务完整环境哈希、挂载与更新前相同，PG/gateway容器ID和镜像未变。未运行migrate/seed/清库；保护浏览器及原页面不刷新、不登出。自己的临时context建立短期session，未改密码。只读根目录下的私有实例索引未改写，实际运行版本以本审计为准。

```bash
python /home/quant/repos/.mw-notification-batch-20261020/operate.py status
python /home/quant/repos/.mw-notification-batch-20261020/operate.py start
python /home/quant/repos/.mw-notification-batch-20261020/operate.py stop
python /home/quant/repos/.mw-notification-batch-20261020/operate.py rollback
```

start/rollback仅对固定13个应用服务执行up --no-deps --no-build --pull never，stop仅停这些应用；不动PG/gateway、卷或其他project。私有配置和回滚清单在仓库外，不提交。

## 测试和CI

偏好、provider/market lifecycle、读取/chunk有界恢复、runtime/persistence、真实Chrome页面退出和React历史缓存回归通过；tsc/生产构建/原生bundle、变更Python Ruff及diff检查通过。新增native-preference-notice已加入CI，实际adapter→bridge回归在旧HEAD为红（error通道），最终候选为绿，含直接设置、成功恢复、保存/删除隔离、延迟scope和只读零写。

首次全量缺PG：2050 passed /562 skipped /38 setup errors，不算通过。补独立任务PG后：2620 passed /16 skipped /14 setup errors；768MiB临时PG空间耗尽，后续连接失效。只重建这个任务库后，受影响14项补跑 **14 passed，17.70s**。共2634个测试用例执行通过、16跳过，分两次完成；不把原单次全量失败写成绿色。没有使用真实验收库跑测试。

`104e8db` CI [39409199005](https://github.com/hezongyi/market-watch/actions/runs/39409199005)通过。最终产品 `b32c2f8` CI [39414732895](https://github.com/hezongyi/market-watch/actions/runs/39414732895)已通过；文档归档提交另触发最新CI，最新结果以PR checks为准。

保守兼容边界：旧listener/世代归属不明或浏览器时钟偏差时保留故障，可能存在额外历史记录。长期稳定性、生产发布和真实交易不属于本次已验证内容。此前明确跳过的“系统浮窗不消失”历史问题不扩入本批。
