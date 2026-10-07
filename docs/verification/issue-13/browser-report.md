# P0 真实网页、原生图表与完整 API lifespan 基线

Ubuntu quant-server，独立project `mw-issue13-p0`、PG14/issue13，当前主线`0591e56`和本地published告警取数小修复。使用本工作树构建的产品React网页、私有许可原生图表、真实认证/PG API、完整API lifespan、真实发布worker与一个Chromium153容器；合成固定历史行情，无供应商外部连接。

运行地址：应用`https://192.168.7.232:19615`，独立图表`https://192.168.7.232:19616`；本任务自签证书，Playwright在本地验收context允许证书错误。运行结束后服务已停止，地址不保持在线。私钥、登录和许可库均未提交。

| 实际步骤 | 耗时 |
| --- | --- |
| M1 idle 30s | 30.00s |
| M5 period switch | 0.39s |
| EURUSD identity switch | 0.79s |
| two-chart native layout | 31.54s |
| manual save | 0.07s |
| reload persisted layout | 20.86s |

浏览器总时长96.61s，数据请求12次；浏览器观察到的published `/api/charts/data`完成时延nearest-rank p50/p95/p99 80/183/183ms。这些样本混合首次加载、周期/身份/布局变化与轮询，含调度/浏览器回调，不能直接替代固定500bar网络API基线。

真实原生图表检查通过：M1非空视区、M5切换、EURUSD身份、第二图XAUUSD数据就绪、实际Ctrl+S持久化返回200、刷新后两图身份恢复。pageerror为0；每个请求状态、失败/取消、视区和检查点全部保留。页面操作未mock路由或改写行情数据，native公开API驱动周期/身份/布局。合成价格不能解释为真实行情或供应商SLA。

| 本任务容器 | CPU样本数 | CPU均值（单核%） | 最大采样值 |
| --- | --- | --- | --- |
| mw-issue13-p0-api-1 | 9 | 5.38% | 12.48% |
| mw-issue13-p0-browser | 8 | 12.53% | 47.19% |
| mw-issue13-p0-chart-origin-1 | 9 | 0.00% | 0.00% |
| mw-issue13-p0-postgres-1 | 9 | 16.89% | 29.90% |
| mw-issue13-p0-publisher-1 | 9 | 31.87% | 38.73% |
| mw-issue13-p0-web-1 | 9 | 0.09% | 0.63% |

应用/API+发布+两静态服务+浏览器CPU配置上限合计1.45核；同时完整采样8次、均值49.31%、最大采样93.05%。PG另0.75CPU/512MiB。配额是上限约束，Docker统计短区间可能波动，采样均值不证明持续容量或生产配额；浏览器1536MiB、API/发布各768MiB、静态服务各96MiB。内存、swap、宿主竞争原始数据见host.jsonl，缺少逐cgroup连续限流统计，不能给出精确限流延迟归因。

API与publisher实际仅连接internal网络`mw-issue13-p0_offline`，PG和反向代理连接本任务网络；没有采集实例、通知worker或真实上游凭据。完整API lifespan会启动预热/实时/告警/transport后台线程，外部请求因网络隔离而不可达；这是离线managed消费负载，不是包含成功供应商I/O的完整容量验收。一个active published收盘告警处理固定历史，没有新触发，健康可为stale；短样本不证明输入到告警时延。

初次验收配置失败均保留独立目录：宿主headless包装路径、Chromium系统库、静态许可目录权限、LAN HTTP非安全上下文、前端构建继承私有umask。修正验收环境后才重跑；没有以初始化失败当成通过、没有修改产品以绕过浏览器安全上下文。Compose增加init使无信号处理的publisher停止时不用等待强制终止；此前exit137经inspect为OOMKilled=false。

运行准备：`/home/quant/repos/market-watch/.venv/bin/python docs/verification/issue-13/prepare_browser.py`；执行`python3 docs/verification/issue-13/run_browser.py`。已有证据拒绝覆盖；重跑需先明确归档。本任务PG启停及私有基础env见[README](README.md)。构建经本机`mw-docker`登记task=`issue13-browser-baseline`，使用专用BuildKit。

证据：[浏览器结果](results/browser/result.json)、[截图](results/browser/product.png)、[实际服务与配额](results/browser/services-runtime.json)、[网络隔离](results/browser/network-isolation.json)、[原始宿主](results/browser/host.jsonl)、[审核](results/browser/artifact-audit.json)。许可图表资源只留Ubuntu私有目录，构建/源码SHA保留且不含许可字节。

P1–P3仍等待三层合并。此补测填补真实网页/双图/生命周期短并发准备，不能宣称Issue #13核心空闲性能、增量调度、覆盖迁移/回退或三重复完整验收已完成。
