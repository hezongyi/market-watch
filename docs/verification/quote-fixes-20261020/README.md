# 两项行情问题修复与验收（2026-10-20）

风险F0：兼容的行情状态分类、共享任务通知和价格显示修复，无schema或持久格式迁移。用户授权修复、验收、提交PR并review。候选源码`1796ade`，实际镜像见运行审计。沿用长期实例与现有配置；原用户页面和浏览器现场保留。

## 行为变化

- OANDA共享缓存过期/首次等待现在分别输出`stale`/`pending`，保留原始价格及采样时间，附缓存年龄、最后成功读取和等待原因。等待不立即生成失败事故，也不恢复已有事故。真实网络异常继续作为失败。
- 同一共享任务先以2–2.5秒间隔重读缓存，连续等待30秒升级为“OANDA 报价暂未更新”，随后恢复正常15秒节奏。没有新增供应商HTTP轮询；多窗口仍归属一个任务。取消观察重置等待窗口，不把取消当恢复。真实成功采集更新后恢复。
- 自建行情报价沿用原生声明的品种精度，Dukascopy等供应商展示默认不再覆盖自建系列。平台行情仍沿用原有供应商政策，原始报价不舍入。

## 验证

- 修复前回归明确失败：自建5位价格被scale=100覆盖；共享缓存16秒过期进入失败通知。原只读分析证据保留于相邻两个目录。
- 定向后端48项通过，包含真实共享缓存→报价快照→持久通知投影，多消费者、首次无报价、短暂等待、30秒升级、取消后重开、真实恢复和有限快探测。见[targeted-backend.log](targeted-backend.log)。
- 实际API候选镜像中的产品代码、只挂载测试目录，在无网络的独立临时容器和内存SQLite运行11项，全部通过。未往真实实例写入故障样本，见[image-regression.log](image-regression.log)。
- 供应商扩展94项通过，另1项既有60ms预算测试在本机波动；相同完整测试文件在修改前基线同样94通过/1失败，见[候选](provider-regression.log)与[基线对照](baseline-provider-regression.log)。曾有一次包含该项的扩展执行通过；不把本地全套写成全绿，最终完整结果看PR CI。
- 价格格式、订阅传输恢复、原生chunk恢复、偏好保存通知检查通过；Ruff、JS语法、diff检查和Web完整构建通过。
- Playwriter正常登录自有隔离context访问`mw75-real`：自选表EURUSD `1.12224`、USDCAD `1.40420`、黄金`4,114.705`，DOM/aria与原始价格及精度逐一匹配；刷新后仍相同。平台外汇5位、黄金3位和BTC2位继续可用。[浏览器断言](browser-evidence.json)、[实拍](watchlist-current.png)。等待态纯函数验证保持原价，描述为“报价暂未更新，保留上次数据”，未向页面发布合成行情。
- 实例只读检查4个相关共享报价任务均`fetch_status=ok`、`notice_open=false`；[当前任务](live-shared-tasks.json)。此观察不冒充长时间稳定性保证；持续等待和故障恢复由上述确定性回归覆盖。

## 实际实例与回退

Ubuntu `quant-server`，Compose project `mw-issue75-v2-20261018`；[验收页](https://192.168.7.232:18280/advanced-charts/mw75-real?panel=notifications)。15服务running，API/PG healthy。13应用服务更新；PG、gateway、初始化容器未替换，全部17容器环境与挂载逐一比对不变，11个运行后端Yahoo均保持true。未migrate、seed或清数据。

| 制品 | Tag | 镜像ID |
| --- | --- | --- |
| API及10个worker | `market-watch-api:quote-fixes-20261020-c1` | `sha256:11a7e86758538da2659ee7515cb4939598944cb6580b1457e9cb2a71348ed216` |
| Chart | `market-watch-chart:quote-fixes-20261020-c1` | `sha256:affc34fdc1e69acfe6bf0b4f0f1debf763c60c1bc458ae37a6f3e8489a9bf410` |
| Web | `market-watch-web:quote-fixes-20261020-c1` | `sha256:bde9ec702519142fa969377440a987f6c09bd14b622bf513d1b8e6fa25e142e5` |

安装版mw-docker与market-watch-ubuntu builder构建；构建时只有已知无关未跟踪历史文档，产品源码固定到候选。完整[运行审计](running-audit.json)。

启动/状态/停止：`python /home/quant/repos/.mw-notification-batch-20261020/operate.py start|status|stop`，其candidate overlay已指向本轮候选。本轮回退必须使用私有`quote-fixes-rollback.json`，结合原`integrated-compose.json`，仅对该overlay列出的13服务执行`up -d --no-deps --no-build --pull never`；不要用旧批次默认rollback代替。旧镜像保留。未合并或发布生产。

## PR与review

沿用Draft PR #87；review范围采用PR实际base到最终HEAD，同时对本轮两项缺陷重点回查。最终review报告另行归档，最终CI以该PR当前HEAD为准，不通过回填CI状态再触发无穷构建。
