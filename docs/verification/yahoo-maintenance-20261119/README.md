# Yahoo 自建维护 TLS 失败与失败版本反复创建

2026-11-19；基线95f096f1，本轮运行代码fa36ff5f。F1：重要后台维护调度修复；无schema迁移，已有frame_plan JSON增加可选运行计数。适配旧记录缺省为0，旧读取方可忽略该计数。

## 已证原因与修复

QQQ（Yahoo D1派生自建）的维护从代理发起连接后，fc.yahoo.com、guce.yahoo.com及query2.finance.yahoo.com均在TLS握手失败；curl_cffi报告SSLError/code35，无HTTP响应，未观察到证书验证错误。同一容器独立重建Chrome／Firefox／默认客户端，以及HTTPX客户端仍失败，不能归因于长期会话污染。相同代理请求Google204成功。

Mihomo的Yahoo专用选择组仅有两个香港出口；供应商节点状态均不可用，独立Yahoo图表接口探测失败。现有美国直连节点对同一Yahoo接口探测200。原香港组以通用Cloudflare地址检查且没有跨区域备选，无法在两个香港节点同时故障时恢复Yahoo。

- 在现有代理配置中增加Yahoo专用的美国／香港fallback，优先已验证的美国节点，以Yahoo真实图表接口及预期200进行健康检查；保留原香港组供回退。将Yahoo选择组指向新fallback；不改变OANDA、Dukascopy及全局选择组。配置经Mihomo校验，再保存并重载；原配置及原选择留档。未关闭TLS验证，未改变供应商身份、报价口径、历史范围或数据内容。
- 修复native_history_archive._publish：失败原先把每日维护提前至约一分钟后，每次都创建新的失败版本。新增每个输入周期的连续失败运行计数，按5／10／20／40／60分钟退避，最多1小时；上游指定更晚retry_at时继续尊重。成功清零；不同周期独立处理，继承周期不重复计数。显式手动重试仍沿用现有入口。
- 运行计数不参与配置指纹；重新保存同一配置保留计数及next_due，不制造编辑冲突。已发布版本、失败审计和原有任务全部保留，不清理历史记录。

## 验证

红测试经过完整schedule_tick→create_run→import_page→失败发布路径，旧代码实际只退避60秒，断言300秒失败；修复后验证连续六轮退避、窗口内不再建新版本、上一可用版本保留、恢复成功、配置指纹不变。另验证上游要求2小时后重试时不提前，并验证保存同一配置保留运行计数及next_due。

- SQLite：维护／Yahoo／原生历史四文件92项通过；模式、保留及请求证据另32项通过，共124项。
- Ubuntu任务隔离PostgreSQL：模式／原生周期／锁与发布26项通过，包含新增退避回归。持久开发库未做故障注入。
- Ruff、git diff --check通过；独立Standards与Spec评审未发现阻塞问题，建议的上游更晚重试和保存同配置边界已补测通过。

## 实际恢复与部署

代理修复后，同一archive_page真实输入从失败恢复为6,762根日线，独立读取16.93秒；这只是供源对照。随后原data-worker自动完成真实维护，版本4c1f4029-0537-482e-acb9-f16d2093c0fd发布，HistoryReadAttempt记录data且accepted=true，活动任务清除、last_success推进，下一次维护恢复为正常每日计划。

- D1 6,762根、W1 1,403根、MN 323根产物全部published。
- 实际认证图表API各读取30根，D1／W1／MN均pending=[]，0.074–0.090秒。
- 后续观察至21:49 UTC，失败版本数保持185，未再每分钟创建失败版本。失败记录未删除；较早179/178是采样时动态数量。
- 应用修复部署到Ubuntu本机quant-server持久mw-dev，只替换api和data-worker，镜像sha256:ee7bf15fde6f197cc603a22cc62dc03e8b4217f963d5e8a68c34c073cd4379bf，对应fa36ff5f；market-runtime仍运行前一已验收代码2558e6d5，因不执行本次修改路径而保持不动。其他服务容器ID保持，数据库、凭据、通知及下载配置保留。
- 入口 https://quant.kookvv.com:8443 。启动入口为持久launcher对应run.json，执行 `docker compose -p mw-dev -f <实际run.json> up -d --no-deps --no-build api data-worker`；停止仅对这两个服务用同入口stop。私有证据目录有部署前配置及逐服务镜像回退脚本。无需更新APK。
- 代理调整属于现有网络服务的Yahoo专用路由修复；没有在Unraid创建Market Watch测试实例，也未部署Market Watch生产版本、打tag或合并PR。

私有配置前后副本、Mihomo校验、运行恢复摘要、实际图表读取及部署记录保留于 `~/.local/share/market-watch-dev/evidence/yahoo-maintenance-20261119/`，不提交完整代理配置及凭据。当前成功不承诺上游永不故障；两个区域全部不可用时仍会按退避等待恢复。
