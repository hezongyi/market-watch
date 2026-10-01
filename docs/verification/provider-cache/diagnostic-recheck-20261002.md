# 两项性能问题复核

2026-10-02（本地日期），本机隔离环境。没有生产修改或上游写入。当前 API/web/chart 镜像仍为 `provider-startup-metadata-20261001`，精确 ID 见 `startup-metadata-runtime-images.txt`。本轮只增加诊断工具与证据，没有修改产品代码。

## 结论

两项现象均可复现。已确认等待阶段，网络证据尚不能进一步区分代理出口、远端链路与上游服务器。不能以本次正常样本宣布冷首屏三秒稳定性全部收口。

### HTTP 等待

`httpx-protocol-recheck-20261002.json`：六轮交替协议、每个平台/协议各六个新客户端，每客户端两次调用，总计48次。每阶段超时4秒；不是运行API的8秒预算。没有行情缓存。

| 平台/协议 | 新客户端第一次成功数 | 第二次成功数 | 确认实际复用成功数 |
| --- | ---: | ---: | ---: |
| Binance HTTP CONNECT | 5/6 | 6/6 | 5/5 |
| Binance SOCKS5h | 2/6 | 6/6 | 2/2 |
| OANDA HTTP CONNECT | 6/6 | 6/6 | 6/6 |
| OANDA SOCKS5h | 6/6 | 6/6 | 6/6 |

第二次调用不一定是复用：第一次TLS失败后的第二次会重新建连，所以不能把12个Binance第二次成功都计为复用成功。

- Binance HTTP慢成功样本3492.81/4186.77ms，其中TLS3279.70/3756.22ms；后一客户端随即复用575.70ms。
- 本轮五个失败均为新连接TLS ConnectTimeout：HTTP一次、SOCKS四次，约4002–4025ms。代理本地TCP连接通常低于2ms，SOCKS协商通常低于8ms；不能把握手后的等待归为本地TCP连接慢。
- 实际复用的Binance HTTP样本179.12–575.70ms；OANDA HTTP259.77–389.56ms。OANDA所有新连接均成功。支持保留默认HTTP代理，不能据此宣称代理永远不会波动。
- 以前真实运行API的8511.11ms失败中TLS7729.19ms、额度6.57ms，见 `runtime-confirmed-tls-errors.txt`。以前正常复用连接等响应头1925.63ms使首屏3769ms，见 `first-screen-transport-lanes-18.json`。这是不同等待阶段，不应统称连接池故障。

`runtime-recheck-20261002.json`：运行API串行16个不同历史窗口、全部200且cache_hit=false。Binance八次263.11–277.50ms（HTTP182.47–184.40ms），OANDA八次368.21–871.58ms（HTTP283.44–786.82ms）。此次没有再次复现运行API的7.6–8.5秒等待；独立同款HTTPX探针复现了TLS慢与超时。不得把这两种测试条件混写。

已知失败CONNECT隧道耗尽HTTPX池另有稳定最小复现及修复，见 `failed-tunnel-pool-exhaustion-red.txt`、`transport-maintenance-green.txt`。本轮 `transport-recheck-20261002.txt` 四项通过（0.48秒），覆盖池代际恢复、在途读者、通道隔离、空闲让位与真实TLS失败后不耗尽池。

### 请求前初始化

`first-screen-recheck-20261002.json`：六次新原生文档/空PostgreSQL平台缓存，公开API包装计时，无资源路由、无vendor改动；静态资源正常缓存、API使用运行HTTP池。

| 样本 | 导航至行情API | API完整返回 | 首屏dataReady+两帧 |
| --- | ---: | ---: | ---: |
| OANDA M1 | 1076ms | 490ms | 1748ms |
| Binance M1 | 950ms | 293ms | 1375ms |
| OANDA M5 | 1595ms | 410ms | 2176ms |
| Binance M15 | 967ms | 324ms | 1449ms |
| OANDA D1 | 996ms | 411ms | 1615ms |
| Binance H4 | 1232ms | 334ms | 1815ms |

OANDA M5图表构造122.6ms，onReady611.6ms、resolveSymbol884.1ms、解析回调1174.9ms、getBars1462.0ms（均相对chart frame时间原点）。请求前有361/270/77ms长任务。第一次解析消费启动元数据，没有resolve网络往返；setTimeout(0)异步回调仍可能被原生执行及调度延后，不应理解为业务设定约290ms等待。首次行情API发起1595ms说明旧1.367秒现象仍能重现，并非固定时长。

`boot-cpu-20261002.json` 两次真实启动CPU采样：chart frame中首次getBars前可明确归属vendor脚本539.99/567.72ms，自维护host脚本2.34/0ms；总采样894.38/866.74ms。其余包含浏览器program/GC/idle/DOM等，不能全部归到vendor。vendor runtime模块加载函数单个约162ms，原生图表库/工具栏/布局计算也占用CPU。采样仅涵盖chart frame及采样开始后时间，不包含主站所有工作，且采样有开销；正式首屏成绩使用无CPU profiler的六次样本。

CPU探针第一轮在原生内部尚未就绪时调用activeChart导致诊断驱动异常，记录保留在 `boot-cpu-20261002-driver-failure.json`。改为等待宿主ready后停止采样，两次均成功；不是产品错误，不计作正常性能证据。

## 可重复命令

```bash
PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_provider_transport.py
.venv/bin/python scripts/diagnose_provider_transport.py --rounds 6 --schemes http,socks5h --output /tmp/provider-transport-recheck.json
.venv/bin/python scripts/diagnose_provider_runtime.py --anchor 1785268800000 --output /tmp/provider-runtime-recheck.json
```

真实首屏驱动：`web/tests/advanced-provider-first-screen.browser.cjs`；指定 `FIRST_SCREEN_BOOT_TRACE=public`、`FIRST_SCREEN_RESET_CACHE=1`、验收证书SPKI和Chromium路径。CPU工具 `scripts/diagnose_provider_boot_cpu.cjs` 包装同一个驱动，另设 `BOOT_CPU_OUTPUT`，从web目录运行。所有数据/凭据从既有本机隔离配置读取，不输出认证值。

## 后续处理

保留HTTP代理、连接池通道隔离/失败换代/空闲维护。产品已实施的挂载、限量工作区和首次元数据优化有效，但原生启动与上游响应长尾仍会叠加。进一步优化需对公开配置/宿主启动时序分别做单变量对照；不向datafeed添加调度、预取或价格缓存策略，不修改vendor。外部网络最终归因需要代理侧同时间的出站握手证据，当前客户端无法替代该证据。
