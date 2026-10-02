# v1.3.0 基线：平台首屏连接池修复

基线为 `v1.3.0` / `b9d69dd4c7ff8e873c4c75f07054eac29c94b996`。独立分支
`fix/provider-first-screen-latency`，worktree 为
`/home/quant/repos/market-watch-provider-latency`。本次修复不改变 v1.3.0
已经接受的“大多数冷缓存首屏低于三秒”标准，不创建新发布标签。

## 根因与实施

长尾由可控的连接生命周期缺陷和外部出口等待叠加。代码中确认了三个缺陷：

1. chart 池容量为二，启动只建立一条连接。两个请求重叠时，第二个仍需冷建连。
2. 顺序 HEAD 总是复用第一条连接；第二条超过 60 秒后过期。单张图每 15 秒读取
   又不断更新整个池的使用时间，导致原保活完全跳过，不能维护闲置的第二条连接。
3. 预热两条连接时，后台会持有第一条 HEAD 的响应等待第二个 history 额度；
   前台到来后原额度等待不能及时取消，可能占用前台需要的连接。

修复在 `provider_transport` 内集中处理：以流式 HEAD 暂时持有第一条响应，
取得第二条连接后消费空响应并关闭，使两条真实 HTTP/1.1 连接都可复用。
启动和后台维护共用此逻辑。维护时钟与普通读取分开；后台仍只使用 history
额度，额度等待每 100ms 检查前台活动，取消后消费、关闭已取得的响应。
在途网络操作仍受原有超时约束；没有声称能立即中断正在进行的 HEAD。

连接容量仍为每源 chart=2、realtime=1、history=1；没有提高数据库池、请求
额度或重试次数。每次完整维护使用两次根路径 HEAD，不读取 candles、不认证、
不写入行情缓存。后台修复任务仍能阻止 history 额度获取。连续前台活动或修复
任务占用额度时，后台预热可以跳过，实际请求继续保留真实错误和池代际恢复。

外部链路的根因范围见
[历史诊断](verification/provider-cache/provider-blockers-root-cause-20261002.md)：
Mihomo 先返回 CONNECT 200，随后才准备出站，所以 HTTPX 的 TLS 阶段包含
代理出站准备，不能全部归因于 Binance TLS。旧 OANDA 已复用连接的 4.574s
响应头等待是独立故障路径，预连无法消除，当前没有证据证明它已经彻底解决。

## 可重复的修复证据

真实持久 TCP 服务回归覆盖启动两并发、闲置 80 秒、单读者每 15 秒读取和
后台让位。前两项在 v1.3.0 上因为新增 TCP 连接而失败，见
[原基线失败](verification/provider-latency/transport-baseline-red.txt)。
单读者回归在修复前得到 `assert 3 == 2`；后台让位回归在修复前超过 400ms
退出上限。全部修复后相关测试 38 项通过。使用 HTTPcore 的真实过期时钟，
测试没有用 MockTransport 冒充连接复用，也没有等待一分钟。

```bash
PYTHONPATH=backend .venv/bin/pytest -q \
  backend/tests/test_provider_transport.py backend/tests/test_provider_chart.py
```

[真实提供商重叠读取](verification/provider-latency/transport-overlap-real.json)
在相同本地出口上比较单条 HEAD 与两条预热，不清库、不修改共享代理：

| 提供商 | 单条预热的首次重叠对：最慢读取 | 两条预热的四次读取范围 | 两条预热后的新 TCP/TLS |
| --- | ---: | ---: | ---: |
| Binance | 1656.72ms | 343.31–356.62ms | 0 |
| OANDA | 1001.32ms | 303.45–640.00ms | 0 |

16 次读取全部获得完整 200 根原生 M1 bars；单条预热时两家各有一个重叠读取
触发新 TLS。复测入口为 `scripts/diagnose_provider_pool_overlap.py --output …`，
需在环境中提供对应代理与账户配置；输出不记录认证信息。

## 独立出口对照与实际首屏

从 `ssh unraid` 的 Docker Mihomo 只读取得配置，在本机启动相同 v1.19.31
独立实例。订阅凭据和节点配置只存于 `/tmp/mw-provider-latency/private-proxy/`
（目录 700，配置 600），没有提交。实例不订阅、不自动切换、不改变远端选择器。

[三轮交错路由对照](verification/provider-latency/routes-comparison.json)
保持目标域名、DNS、嗅探配置和 HTTP 协议一致，仅固定不同出口：

| 路由 | 成功 / 读取数 | 最大请求时间 |
| --- | ---: | ---: |
| 共享日本02 | 4/5 | 4007.25ms |
| 同一日本02，代理移到本机 | 2/4 | 4006.21ms |
| 本机日本01直连 | 6/6 | 3227.26ms |
| 本机日本 VMess | 6/6 | 1807.26ms |
| 共享美国01 | 6/6 | 1154.03ms |
| 本机美国01 | 6/6 | 1344.54ms |
| 本机美国02 | 6/6 | 1181.06ms |

失败后结束该客户端，没有把污染池后续 PoolTimeout 当作新失败。39 个读取
是小样本，不能宣称 VMess 永远稳定。日本02移到本机仍失败，支持节点/出站
路径相关等待，并不证明具体 DNS、节点服务或某一段运营商线路是唯一根因。

本地组合为 Binance `127.0.0.1:15783`、OANDA `127.0.0.1:15784`。
现有 `ALERTS_BINANCE_PROXY` / `ALERTS_OANDA_PROXY` 足以配置分别指定的出口，
不需要增加产品自动竞速、重试或修改提供商入口。这个配置是本地验证方案；
生产长期运行仍需在实际部署主机提供受限的专用监听。

[最终九周期矩阵](verification/provider-latency/first-screen-fix-18.json)：
每个样本清空**独立数据库的 provider 缓存**，新建原生图表文档；连接在 API
启动时预热，不能称为“每次都重新冷建 TLS”。两家各九周期：

- 冷缓存首屏 16/18 低于三秒，范围 1639–3053ms，符合既有多数标准。
- Binance D1=3048ms、W1=3053ms 原样保留，未删除慢样本。
- 18 个完整、新鲜 PostgreSQL 缓存需求到显示均低于一秒，范围 208–595ms。
- 首屏行情读取没有新 TCP/TLS；所有响应满足原生 countBack 或真实边界。
- 慢样本分别在 1897ms / 1364ms 发起行情需求，上游响应头约 377 / 400ms。
  宿主执行、API 调度和提交共同占用剩余预算，没有证据将这些样本归入冷 TLS。
  该轮后半段有同机 Docker 构建，存在资源争用，保留全部结果，不声称因果改善幅度。

[前一轮矩阵](verification/provider-latency/first-screen-before-periodic-fix-18.json)
为维护时钟修复之前的中间状态，18/18 低于三秒，仅保留历史，不能替代最终代码证据。
[首次环境初始化失败](verification/provider-latency/first-screen-fixture-missing-catalog.json)
未发出 candles 请求：新数据库尚未刷新 OANDA 账户目录；通过正式目录刷新 API
完成初始化后重测，没有伪造品种或数据。

最终代码另沿用未更改的共享代理进行六样本复核，见
[共享出口复核](verification/provider-latency/first-screen-shared-egress-six.json)。
5/6 首屏低于三秒，1530–3680ms；缓存需求到显示 199–665ms。
Binance M1 慢样本仍发生新建连接，代理/TLS 2238.37ms、完整 API 2538ms。
这说明网络失败、连接被关闭或后台未能预热时，应用不能保证消除冷连接。
该对照不证明端到端性能的统计改善，也不证明 OANDA 响应头长尾消失。

## 验证环境与复现

隔离项目 `market-watch-provider-latency`；数据库 `market_watch_provider_fix`，
连接原本机隔离 PG16 服务，未清空 `market_watch_dual`。API/Web/TLS 只绑定
本机端口，CPU=1、内存=512MiB 各服务；通知关闭，API DB pool=1、overflow=0。
原 v1.3.0 七服务继续运行，没有改生产或共享 Mihomo。

- 主站 `https://localhost:15463`，图表 `https://127.0.0.1:15464`。
- [无秘密 Compose 快照](verification/provider-latency/fixture-compose.yaml)、
  [TLS 配置](verification/provider-latency/fixture-tls.conf)、
  [Web 配置](verification/provider-latency/fixture-web.conf)记录本机实验部署。
  env、TLS 私钥与代理凭据继续位于 `/tmp`，没有写入 Git。
- [18 样本镜像记录](verification/provider-latency/runtime-local-egress-18.json)
  记录实际运行的镜像 ID；最终维护逻辑与记录镜像一致，随后仅改一行代码注释并
  重建 API，六样本复核及最终运行记录匹配当前源码。
- [最终本地运行记录](verification/provider-latency/runtime-final.json)包含源码散列、
  镜像 ID 和资源限制；复核后恢复本地独立出口组合，仅供本机实验。
- `scripts/provider_acceptance_fixture.py --profile provider-fix` 只接受写死的
  本机地址、端口、数据库组合；默认 dual 行为保留。

```bash
cd web
LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
FIRST_SCREEN_APP_ORIGIN=https://localhost:15463 \
FIRST_SCREEN_CHART_ORIGIN=https://127.0.0.1:15464 \
FIRST_SCREEN_FIXTURE_PROFILE=provider-fix \
FIRST_SCREEN_RESET_CACHE=1 FIRST_SCREEN_CHECK_WARM=1 FIRST_SCREEN_BOOT_TRACE=public \
FIRST_SCREEN_OUTPUT=/tmp/provider-fix-first-screen.json \
node tests/advanced-provider-first-screen.browser.cjs
```

[后端 PG16 全套](verification/provider-latency/backend-pg16.txt)：307 passed、零跳过，
包括 dump/restore 和数据库迁移，破坏性测试仅使用 `market_watch_isolated`。
[前端 VM](verification/provider-latency/frontend-vm.txt)：35 passed。
API 与前端 Docker 构建成功，修改文件 Ruff 与 `git diff --check` 通过。
已按真实环境及代理凭据做敏感值扫描，未在新增/修改文件中发现匹配。

## 解决方案的边界

应用修复消除了容量二但只预热/维护一条连接的漏洞，并让后台额度等待及时
让位。持续前台占用、后台修复、上游主动断连或服务故障时，仍可能需要冷建连。
长期部署应使用经真实 candles 延迟验证的独立出口；通用 204 健康检查不能
替代行情性能。OANDA 复用连接的上游长尾需要进一步取得慢请求 RequestID
与路由关联，不能靠扩大池、延长截止或把错误伪装 noData 来解决。

新增真实 TCP 生命周期回归能在将来提前发现此类缺陷。仅验证 HEAD 调用次数
或 MockTransport 的测试无法证明两条连接已建立、被维护并可供并发读取。
