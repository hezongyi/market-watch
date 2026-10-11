# v1.20.2 行情修复验收

基线 `0cebcf5`，应用实现 `df7affb`；Docker 打包加入有限会话生成脚本，最终测试夹具
`e20b812`。测试比较安装在镜像中的 alerts 包；没有用源码 PYTHONPATH 替换产品包。
独立 PostgreSQL 14 位于 Ubuntu quant-server，project/task `mw-provider-fix-20261011`，
使用专用 `market-watch-ubuntu` BuildKit 和 `mw-docker` 构建。没有在 Unraid 创建验收实例。

源码后端 1466 通过、389 跳过；跳过包括要求独立 PG 的测试，不计为通过。
网络分支后续 89 通过。安装镜像中相关 PostgreSQL 业务 56 通过；新增真实 PG
路由和闭市→未知边界→计划复市保护 11 通过。后者先修复夹具外键 flush、单品种常驻
设置和空结果合同，然后 11 全通过；没有跳过失败。最终镜像核心 35 通过（11 PG、
10 网络、10 路由、4 会话）。最终 PG 夹具只读挂载，产品包始终为镜像已安装包。
其余 installed targeted 142 项通过，首次 5 失败分别为代理模式夹具未显式固定，以及
会话脚本未打包；补齐模式夹具和 Dockerfile 后相关 14 与核心 35 全通过。

真实 HTTPcore CONNECT 代理/socket/pool/trace，只有 TLS 加密握手 seam 为人工注入；
首次 EOF 后新 socket 恢复，两个请求共享 deadline，各取得额度。证书/401/429 不盲重试。
真实 Ubuntu 公共 Binance GET 六次冷连接、六次复用成功，M1 实际写入独立数据库。
OANDA 未用生产凭据或创建第二 pricing stream；开市恢复是隔离、人工控制的数据合同测试，
不宣称本轮周末已验证生产开市价格。会话证据仅影响计划状态与调度，当前 M1 仍独立保护。

页面验收通过：网站 `https://192.168.7.232:19819/`，独立图表来源
`https://192-168-7-232.sslip.io:19820/`（本轮自签证书）。真实许可图表加载 Binance
平台 M1，数据中心、来源状态、登录退出通过；0 页面异常、意外 HTTP 错误或图表域凭据泄漏。
默认观察列表 EURUSD/XAUUSD 的 422 仅表示本独立实例未配置 OANDA 凭据，已单独记录；
没有将其当成真实 OANDA 验收。本目录不含密码、env、证书私钥、原账户 ID
或许可图表库。私密操作材料在 `/tmp/mw-provider-fix-20261011/`（0700）。
启动/停止该独立 project（不是生产）：

```bash
cd /home/quant/repos/market-watch-provider-rootcause-20261011
sg docker -c 'docker compose --env-file /tmp/mw-provider-fix-20261011/acceptance.env -p mw-provider-fix-20261011 -f deploy/ubuntu/provider-fix.acceptance.yaml -f /tmp/mw-provider-fix-20261011/compose.ui.json up -d --pull never --no-build api web chart-origin tls realtime-worker market-stream-worker'
sg docker -c 'docker compose --env-file /tmp/mw-provider-fix-20261011/acceptance.env -p mw-provider-fix-20261011 -f deploy/ubuntu/provider-fix.acceptance.yaml -f /tmp/mw-provider-fix-20261011/compose.ui.json stop'
```

验收结束按本任务 project 精确 `mw-docker retire`，先预览，再备份及真实恢复校验后退役；
进行中尚未退役。PR、双轴复审、正式备份恢复、tag 与生产验证在后续发布阶段记录。

## PR 固定 head 首轮复审修复

Standards 无文档规范违反，提示两条 Binance 重试路径可能重复；Spec 发现总预算不能
限制持续缓慢响应。真实 socket 每 0.12 秒返回一字节，0.2 秒预算仍约 0.5 秒成功。
新增两入口红回归后，通过线程局部绝对 deadline 包装 HTTPcore 连接、TLS 和每次
读写，完成响应后再次拒绝迟到结果；不通过关闭其他读者连接或残留看门狗线程中断。
HTTPX 0.28/httpcore 1.0.9 在 lock 中固定，backend 集成使用私有 pool seam，需随依赖
升级复验。原生 Binance 与普通入口现共用请求、额度、重试和诊断策略。
111 项来源/图表/池/OANDA 流回归通过（19 PG 条件跳过，另有真实 PG 56 通过证据）。

## 修复后双轴复审

固定应用提交 `253d0550813a5b262e23fd714b4fab4f2df6f812`，比较基线 `0cebcf5`。

### Standards

0 项规范问题或需报告的代码异味；原重复 Binance 策略已统一。独立并发验证中，
一条请求在约 0.151 秒超时，另一条正常完成，后续未设置 deadline 的请求成功，
验证上下文隔离与 reset。HTTPcore 私有集成点仍需在依赖升级时复验。

### Spec

0 个未解决阻断。独立 32 项网络／连接池／供源测试通过，两个真实 socket
慢响应入口都拒绝超时结果；组合身份、精确清理、额度、故障池轮换、鉴权／限流／
证书保护与有限会话规则未发现规格偏差。正式备份恢复和生产结果在发布时另行验证。

预算边界：connect、TLS、read、write 各操作使用剩余预算，迟到结果不会成为成功。
底层同步系统 DNS 解析不能由 socket timeout 中断，多地址连接尝试也受 Python
socket 实现影响；不能承诺所有 DNS 故障下都在绝对墙钟预算内返回。

最新 clean 应用镜像 `253d055`：供源／图表／连接池／OANDA 流 110 通过；独立 PG
路由、闭市保护和共享供源合同 30 通过（其中路由／闭市 11）。初次命令误挂载了旧私密
夹具，仍断言计划复市为 open，1 失败；仓库夹具已正确要求 scheduled_open。移除旧
挂载后以上正式测试清单通过，无产品修改。HTTPS 页面与 Binance 6 冷＋6 复用再次
通过，实际 M1 149 条；证据文件带 review-head 后缀。
