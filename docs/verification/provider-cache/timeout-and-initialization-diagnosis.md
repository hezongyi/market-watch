# API 超时与首次取数前初始化诊断

2026-10-01。本机隔离验收；不是生产结果。整体实施目标仍未完成。

最新补充：2026-10-02重新执行48次协议对照、16次运行API未缓存读取、六次冷库首屏和两次CPU采样，见 [诊断复核](diagnostic-recheck-20261002.md)。再次复现Binance新连接TLS长尾和请求前初始化；不能宣布所有冷首屏稳定小于三秒。上轮八图五分钟与真实重启均已完成并通过。

## 2026-10-02 publication-cadence 运行证据

API/三worker `a087d57ca79f66d31db2b6e130fd9547ddf0700e5b4b881e7517c656a69c362b`；web/chart继续startup-metadata，精确ID见 `../dual-container/publication-cadence-runtime-images.txt`。当前镜像全部安装alerts模块与工作树逐字节一致，差异审计见同目录 `publication-cadence-source-impact.json`。

- [最新18周期矩阵](first-screen-publication-cadence-18.json) 全通过：清空平台PG缓存，新原生文档首次显示1385–2597ms；另一个新文档读完整数据库缓存，请求到显示199–490ms。18项无新TLS，属于数据库冷/运行连接池条件；保留旧3769ms、TLS失败及其他长尾，不把本轮通过当作稳定性完成。
- [首个公开调用](boot-publication-cadence-first-calls.json) 单独提取每个调用的首次出现，避免后续正常resolve污染启动顺序；首个行情API在导航后904–1077ms发起。原生CPU分解仍以此前两次完整profile为准，不从墙钟差值反推所有时间都在vendor。
- [16次实际API缺口读取](runtime-publication-cadence.json) 全200、cache_hit=false，276–4656ms。第7项OANDA等待响应头4574ms，额度3.19ms、DB提交41.92ms，无TCP/TLS阶段：是复用连接上的响应等待长尾，持续连接无法完全消除。探针只按历史窗口取200根，不写managed行情。
- [同历史端点直连/代理对照](oanda-proxy-direct-historical.json) 24次，HTTP12/12成功，六次新连接957–3520ms、六次复用297–784ms；最慢新连接TLS3039.56ms。直连12/12在TCP阶段失败；额外无认证HEAD确认Network is unreachable。直连路径不可用，不能由此区分代理与上游责任。
- [最新真实API重启](restart-publication-cadence.json) 通过：API16616ms、SSE恢复16679ms、数据库缓存57ms，无reset/页面错误；原生保持dataReady、pending0、柱间距不变。

### HTTP/1.1与HTTP/2对照

同代理、同历史端点交替六轮，每家/协议六个新客户端、每客户端两次请求，共48次，见 [HTTP版本对照](proxy-http-version-historical.json)。使用系统诊断Python中的httpx0.28.1/h2 4.3.0，产品依赖和连接配置未改变；最初项目venv没有h2，诊断未能启动HTTP/2，随后换用已有系统依赖重新完成全组。

| 来源/版本 | 新连接成功 | 新连接成功范围 | 第二次请求成功 | 第二次请求成功范围 |
| --- | --- | --- | --- | --- |
| OANDA HTTP/1.1 | 6/6 | 891–1041ms | 6/6 | 280–380ms |
| OANDA HTTP/2 | 6/6 | 931–1247ms | 6/6 | 286–339ms |
| Binance HTTP/1.1 | 5/6 | 763–1972ms | 6/6 | 168–1249ms |
| Binance HTTP/2 | 6/6 | 797–2692ms | 6/6 | 161–193ms |

两家HTTP/2均实际协商HTTP/2；Binance HTTP/2仍有TLS2505ms慢样本。一次HTTP/1.1首次失败后第二次成功发生新TCP/TLS，不能计作复用连接。六个新连接每组不足以证明协议稳定性差异，也未证明能消除已复用OANDA响应等待4574ms。保持默认HTTP代理和产品HTTP/1.1，不用减少样本里的失败当作改配置理由。

需要代理端连接/节点信息以继续区分出站和上游，已向用户询问软件及可读控制API；独立验收工作继续，不以此阻止其他收口。

### 只读代理控制接口与失败连接关联

发现Mihomo v1.19.31控制接口 `192.168.7.33:9090` 可读，无需用户补凭据；只请求version/configs/proxies/connections及info日志，没有修改规则、选择器、节点或日志级别。配置摘要在 `proxy-controller-summary.json`。OANDA实际链为OANDA行情/OANDA美国故障转移/美国01；Binance为日本专属/日本故障转移/日本02。

`diagnose_provider_proxy_connections.py` 在TCP complete公开trace取得本机源端口，匹配connections metadata.sourcePort；观察只保存本次品种连接的ID、节点链、开始时间及字节计数，不保存凭据或无关连接详情。可选controller日志只收两家域名记录。

首轮48请求有4个Binance TLS超时和8个随后PoolTimeout；原始诊断客户端不做产品的失败代际恢复，后者是同一失败池的后果，不计独立上游错误。补日志24请求有21成功，1个Binance TLS超时和2个后续PoolTimeout；通过源端口40064的info日志确认真正失败连接在TLS阶段走日本02，见 `provider-proxy-connection-and-logs.json`。这证明失败路径，不证明日本02节点本身就是根因；外部TLS握手包含节点出站至Binance和对端处理。OANDA复用响应头长尾仍需要同样关联的慢样本。

## 19:15 UTC 后续优化与验收（覆盖旧运行版本）

API/三worker现在为 `15f097b09e6dc1f3833084428b7d4cdf5d9610bcdb565e6e1920f5ce7a7bd779`、web `f77b6fa8a6cca9b90fb818fbee4955c15c7ca50dd8b8057a943d15a89debc3fd`、chart `e801e1e776db6e3aed8b552c9dc521b2a8e8de9b394a4817e731e78f22b50aa4`。

首次限量工作区响应附带当前平台品种元数据，原生首次resolve免一次跨窗口/API往返，仍异步回调；只消费一次，后续解析照常询问后端，不新增数据feed取数/缓存策略，不预取bar。11个自维护脚本合并带哈希资源，vendor不动。旧格式日期同步首次getBars之前通过公开开关暂缓，恢复后还原用户选择，旧绘图/历史视区实际重开通过。

`first-screen-startup-metadata-18.json` 全通过：18空PG缓存、新原生文档首屏1446–2290ms，另一个新原生文档完整数据库缓存需求到显示202–382ms，全部cache_hit=true。当前运行HTTP池，不宣称每条TLS冷。第一轮有超过三秒样本，完整保留 `first-screen-startup-metadata-workspace-load-failure.*`；验收驱动每项前后下载460个完整布局约8.55MB，4核机器CPU等待压力约33%。复跑只用已有布局元数据接口检验数量/身份，产品工作区和后台服务保持，不能因此宣称对任意CPU负载稳定三秒。

`rapid-switch-startup-metadata.json` 全通过：两源首屏1686/1627ms，立即切未缓存周期562/398ms，每源20冷重叠＋20热重叠，无errors/rejections，最终pending=0。OANDA冷序列整体8781ms/Binance4542ms含操作序列，不记为每次切换耗时。完整后端298通过零跳过，35前端VM通过。五分钟八图新镜像负载复验已启动，其他交付门槛仍待审计；网络TLS及响应等待长尾并未因本轮通过而被宣称消失。

## 最新复核：两类问题均可复现，稳定性尚未最终收口

运行版本为 API/三 worker `0879187f2e16f1d687be25c3a1dfb875e8977669d3885f4203aa7b156b157967`、chart `259bf4e5b79f1fc95c107a9fc050307531c6275115d415b74ba957906e115d26`、web `9d44ebd9a107315250716d86cd09ee3a86ab743ad911c7b56b1f30f856628455`。

- HTTP 超时已拆为两种实际故障：真实 TLS 建连波动，以及可控代理稳定复现的失败 CONNECT 隧道耗尽池。异常池恢复、通道隔离和累计 API 截止已有回归，不代表代理出站/上游 TLS 网络波动已经消失。HTTP CONNECT 和 SOCKS 对照均有失败，保留默认 HTTP 代理。
- 最新完整后端 `backend-transport-lanes-full-pg16.txt`：297 passed、零跳过，含真实 PG16 备份/恢复；该结果包含通道隔离改动。
- `mixed-eight-chart-transport-lanes.json`：八图混合完整五分钟、29 次采样、零页面错误，自建行情最大延迟 87008ms，热原生切周期 p95 40.3ms。六个新原生文档启动 1459–3109ms，仍有 3109/3047ms 超过三秒。驱动计时等待工作区 ready，不仅是首屏 dataReady；不能据其 passed=true 宣称首屏三秒 SLO 通过。
- 对上述两个慢品种各补三次独立空 PostgreSQL 缓存测量，`slow-symbol-init-lanes-untrusted.json`：六次首屏 1512–2017ms，首次行情 API 发起 951–1293ms，HTTP 283.68–722.77ms，无页面错误。本轮仍使用本地自签证书 ignoreHTTPSErrors，没有改成精确信任来隐藏差异；这六次没有再次超过三秒，不抹去此前失败。
- 增加仅测试驱动中的公开回调时间记录，没有路由拦截或修改原生 bundle。最新矩阵首轮 M15 再次测得 1392ms 才发出行情 API：原生 resolveSymbol 803.8ms、宿主收到消息 946.9ms、解析 API 947.2–964.6ms、原生回调 1317.4ms、getBars 1384.6ms、行情 API 1392ms。其中解析 API 17.4ms，消息交付和继续调度明显更长，不能把这段归为后端取行情慢。桥接收到结果即调用公开回调；onReady 自身回调等待约8–10ms。约0.4秒的原生执行长任务与后续消息/调度开销仍存在。
- 该矩阵首轮完成七个冷/热周期后，验收驱动在 iframe 已挂载但尚未导航到 chart origin 时提前取 frame，导致测试脚本 TypeError。原失败及已取得数据保留在 `first-screen-transport-lanes-frame-navigation-failure.{json,log}`。已改为等待 iframe 内实际 #chart 后取 frame，重新跑完整矩阵；这是驱动导航竞争，不是产品 API 超时或原生拒绝。

完整复跑 `first-screen-transport-lanes-18.json` 已结束：两平台各九周期共18项都取得200响应，页面错误0；首屏1537–3769ms，17/18低于三秒，OANDA M5一项3769ms，因此最终 `passed=false`。18项随后重新创建原生文档、读取完整且新鲜的PostgreSQL缓存，需求到显示161–324ms，均cache_hit=true；不把原生bar内存缓存当作数据库命中。

这次 OANDA M5 慢样本没有新 TCP/TLS trace、没有连接错误，复用既有连接：

| 阶段 | 时间 |
| --- | ---: |
| 导航至行情 API 发起 | 1303ms |
| 行情 API 完整响应 | 2047ms |
| 其中上游额度排队 | 5.34ms |
| 其中上游 HTTP 完整接收 | 1926.99ms |
| 其中等待响应头 | 1925.63ms |
| 其中数据库提交 | 44.88ms |
| API 响应至首屏 dataReady + 两帧 | 419ms |
| 导航至首屏显示 | 3769ms |

原生公开getBars回调3348.4ms、widget-ready3379.4ms；随后仍有138ms和67ms长任务。首次M1也记录1835ms才发出行情API，其中原生初始两个长任务361+247ms。请求前延迟不是固定1.367秒，随原生执行/调度与宿主初始化波动。这证实**连接复用正常时仍可能等待响应变慢**；持续连接解决建连成本和失败池恢复，不能保证所有上游响应都在目标时间内。

目前客户端可确定TLS建连阶段和已复用连接的响应等待阶段；仅这些客户端证据仍无法把代理出口、远端链路及上游服务器处理进一步分离。不能把网络等待统称为额度排队，也不能凭无TLStrace推断代理节点完全无影响。最新可控池故障命令再次执行通过：1 passed、3 deselected、0.43s。

最后对运行API补16次不同历史窗口只读探针，`runtime-transport-lanes-final.json`：全部200、全部cache_hit=false，Binance8次API298.96–945.59ms、HTTP216.56–814.67ms，OANDA8次API493.05–973.74ms、HTTP433.77–888.37ms。本轮没有复现7.6–8.5秒超时；证明当前请求与异常池恢复可工作，不证明未来不会再遇TLS/上游响应长尾。

最小池故障复核命令（回归使用本机可控代理，不访问真实上游）：

```bash
PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_provider_transport.py -k repeated_real_connect_tunnel_failures
```

首屏复核使用 `web/tests/advanced-provider-first-screen.browser.cjs`，`FIRST_SCREEN_BOOT_TRACE=public` 只包装公开 widget/datafeed 调用并记录 PerformanceObserver；`FIRST_SCREEN_RESET_CACHE=1` 每项清空独立平台缓存，HTTP 连接池保持运行状态。数据库冷缓存和完全冷 TLS 是不同测量条件。

## 17:40 UTC 后续修复与真实复验（覆盖下文旧候选状态）

第二个原因已经确认：HTTP CONNECT TLS 失败会让当前 HTTPX/httpcore 池保留不可用隧道。可控代理连续四次 TLS 失败后第五次只有 PoolTimeout、没有网络 trace；`failed-tunnel-pool-exhaustion-red.txt` 先红，修复后五次都尝试 TLS，不再耗尽池。新传输模块失败时替换池，已经在途的其他读者继续用旧池直到完成；等待者原子转向新代池，旧失败不能丢弃更新的池。异常池已由回归覆盖，不再仅是假设。

`provider_transport` 还负责低频空闲 HEAD、前台让位和保存允许的全部空闲连接；最大池并发4不增加，不拉bar、不写缓存，默认HTTP代理保持。此前80秒空闲探针复现Binance池耗尽；修复后 `transport-idle-80s-recovery.jsonl` 两源均在80秒后复用连接成功，Binance195.92ms、OANDA303.16ms，无新TCP/TLS。

累计8秒API截止和失败退避预算已修复；真实订阅更新改用realtime保留额度。全后端297项通过、零跳过（匹配PG16工具的真实备份/恢复在内），前端34 VM通过。保留TLS波动和完全冷连接失败样本，不声称网络节点从此不会失败。

最新18项平台首屏矩阵 `first-screen-pool-recovery-18.json` 全部通过、零页面错误：OANDA AUD_CAD 与 Binance BTCUSDT各九周期，每项清空PostgreSQL行情缓存、构造新的原生文档。首屏 **1566–2001ms**；随后另一个新原生文档读取数据库完整缓存，需求到显示 **153–393ms**。矩阵使用运行服务的HTTP池；第一份原生资源冷，后续静态资源可缓存。它验证数据库冷缓存下的九周期首屏，不能宣称每条都是上游TLS冷连接。后续多图、重启/修订恢复及完整交付审计仍待继续。

日期同步通过公共snapshot捕获、自己的同步元数据和就绪后还原解决新保存布局的启动竞争。实际部署OANDA/Binance原始混合快速切换及重开、OANDA一日前历史视区、无自动保存循环均通过；旧格式首次兼容恢复仍需最后审计。完整进展见 `chart-dual-dataset-implementation.md` 顶部。

## 结论与边界

两个问题都已多次复现。API 的一个最新真实失败已定位到代理隧道后的 TLS 建连，不是额度排队或数据库。初始化中另有约 300ms 可消除的页面懒加载挂载等待，已实测消除；原生脚本执行与调度仍占较大比例。不能据此宣称全部提供商/周期冷首屏稳定小于 3s。

### 运行中 API

`runtime-confirmed-tls-errors.txt`：Binance M1、198 根，实际首屏接口 503，总耗时 8511.11ms，lease 3.42ms、上游额度 6.57ms、TCP 0.58ms、HTTP 7731.91ms、proxy.start_tls 7729.19ms。两个失败尝试分别记录 ConnectError 5005.04ms 和 ConnectTimeout 2733.09ms。该样本没有池等待证据；旧有无网络阶段的失败尚不能自动归为同一根因。此轮浏览器失败原样保存在 `native-initialization-eager-gzip.json`。

同款 HTTPX 参数交替比较四轮，每源/协议八次（四个新客户端，各两次请求）：

| 提供商 | HTTP CONNECT | SOCKS5h |
| --- | --- | --- |
| Binance | 6/8 成功，两个新连接 TLS 超时 | 6/8 成功，两个新连接 TLS 超时 |
| OANDA | 8/8 成功 | 8/8 成功 |

见 `httpx-protocol-interleaved.json`。首次 Binance 建连成功样本仍可超过 3s；真正复用连接的成功样本通常明显更快。两种协议均发生失败，不能由此前 curl 小样本直接决定改用 SOCKS。

额外 HTTP/直连比较见 `httpx-direct-comparison.json`：Binance HTTP 和直连均 7/8 成功，直连有一次复用连接 ReadTimeout；OANDA 直连 0/8（TCP ConnectError），HTTP 8/8。因此不能证明“全部由代理节点导致”，也不应把默认代理移除。TLS 阶段包括代理出站链路及上游握手，现有客户端证据无法继续区分二者。

运行中 API 的串行历史窗口 16 次均成功且每次 cache_hit=false，见 `runtime-serial-http-timings.json`。这表明复用可正常工作，不支持“每次请求都失败”或“连接池必然损坏”。HTTPX 分阶段超时与重试退避可让总耗时超过名义 8s，是另一个需要收紧的预算问题。

复现命令（只读上游/隔离 API，不写自建行情）：

```bash
.venv/bin/python scripts/diagnose_provider_transport.py --rounds 4 --output /tmp/provider-transport.json
.venv/bin/python scripts/diagnose_provider_runtime.py
```

### 发出第一笔行情请求前

`native-initialization-public-cache-valid.json` 使用 init script 包装公开 widget/datafeed 调用，没有 Playwright 路由拦截。三次 OANDA M1 空数据库首屏的首次行情请求分别在 1444/1813/1491ms 发出。工作区 API 下载本身 8–12ms；页面懒加载资源在约 36–38ms 已完成，但工作区请求到 344–383ms 才开始。原生品种解析 API 8–21ms，响应回调在原生忙碌期间可能延后。

取消专业图表页面 React.lazy，保持标准图表页面懒加载。独立对照 `native-initialization-eager-page.json`：工作区请求提前至 51/57/58ms，图表构造开始 223/177/183ms，证明约 300ms 来自宿主挂载等待。该轮第一条仍因上游较慢超过 3s，失败保留。

本地 TLS nginx 默认以 HTTP/1.0 转发到静态 nginx，导致后者默认 gzip_http_version=1.1 不压缩。只把图表来源转发改为 HTTP/1.1 并清除 Connection，保留公开供应商包。验证 Content-Encoding:gzip，原生主库首次传输从 2662044 字节降至 812210 字节。

重要测量边界：仅 ignoreHTTPSErrors 的本地自签证书环境没有复用原生库缓存。验收驱动可用 FIRST_SCREEN_CERT_SPKI 精确信任本地证书公钥，重复导航的库资源 transferSize=0；这是测试配置，不是产品关闭 TLS 校验。此前 FIRST_SCREEN_BOOT_TRACE=1 还会通过 route 禁用缓存，其结果只用于冷资源诊断。新 public 模式不路由资源。

两项优化部署后，六次真实 OANDA AUD_CAD M1 空数据库首屏（有真实行情 API）：

| 样本 | 行情请求发起 | 行情 API 返回 | 首屏 dataReady + 两帧 |
| --- | ---: | ---: | ---: |
| 1 | 979ms | 1089ms | 2247ms |
| 2 | 1180ms | 782ms | 2136ms |
| 3 | 1090ms | 687ms | 1958ms |
| 4 | 1118ms | 941ms | 2201ms |
| 5 | 1105ms | 897ms | 2129ms |
| 6 | 1107ms | 571ms | 1849ms |

`native-initialization-eager-gzip-oanda.json` passed=true、零页面错误；第一次原生资源冷、后五次静态资源缓存。每次原生实例重新构造，库执行长任务仍约 237–262ms + 167–207ms；缓存资源不能消除执行开销。这里只验证 OANDA M1，不能推广为九周期最终验收。没有修改供应商包、吞掉原生拒绝或把预取逻辑放回 datafeed。

## 当前候选与验证

API/三 worker：`sha256:dee32c5bf7b9155d0cdc4dabaee34c0cfd7bd3ded98b80563eb9c9cb4d50a5ab`（新增异常类别计时）。Web：`sha256:9d44ebd9a107315250716d86cd09ee3a86ab743ad911c7b56b1f30f856628455`（提前挂载）。Chart 仍为 `sha256:25b823be08504caf14e644a51a55bf17a1f97bb70e3b927b2a7209882766b0db`；TLS 使用更新的验收配置。

Web Docker 构建包含 tsc 与 Vite，成功；相关 provider_chart 回归 29 passed。此前完整后端 291 passed 是上一轮结果，不冒充本轮全部复测。失败与成功证据同时保留。宿主挂载提前暴露旧浏览器驱动在 bridge 加载前读 ready 的竞争，驱动改为等 #chart 与 typeof ready 后，真实保存重开、画线保留、手机只读兼容通过、零错误，见 `eager-page-roundtrip-frame-ready.json`；原驱动失败保留。

下一步：在后端传输层验证空闲保活/连接复用策略，收紧累计请求预算；当前 HTTPX 对照不足以更换默认代理协议。日期同步重开原生 undefined 尚未收口，其余完整验收仍须继续。
