# v1.25.7 生产代码发布记录

2026-10-15（America/New_York），PR #70、#71 已合并，附注标签 v1.25.7 固定在 `45769e020ab15b8b3fc6dff7b8969645006971c2`。Ubuntu 正式构建的四类镜像已部署 Unraid，实际发布目录为 `releases/v1.25.7-45769e0`。

**本次仅完成代码升级，生产仍为 stream；REST batch 迁移没有收口。** Ubuntu 补验发现原生 M1 历史加载与共享 REST 最新蜡烛的衔接问题，修复见 [补丁记录](issues/oanda-rest-native-history-20261015.md)。平台高周期直接读取供应商原生周期；组合高周期仍按固定 M1 输入和组合日历聚合。

## 生产切换与恢复证据

停写为 ET 20:04:49–20:22:07，共 1038 秒（17 分 18 秒），包含最终备份和 Ubuntu 实际恢复验证。最终 dump `alerts-20261016T000503483109Z.dump` 为 3,372,881,204 字节，SHA256 `05073638d31113dc35a70dce5ea3ee482e29e979fee7626a396011385f9f0974`。备份流完整字节和校验通过，89 张业务表／90 张 public 表、10 类业务指纹、账户和通知配置核对一致。

恢复后的数据库为 PG14.24，schema 保持 `au48_display_indicator_tasks`；生产迁移为 no-op。新旧应用读取兼容验证通过，包括 v1.25.4 读取 REST 写入后的隔离副本。镜像传输、RootFS／有效 Config、源码标签和 370 个后端 Python 文件 hash 核对通过。

发布代码 CI 2395 passed / 11 skipped；最终 API 镜像专项 274 passed，真实 PG14 专项 53 passed。集合有重叠，不累计计数。

## 上线结果及观察边界

12 个常驻服务运行，API healthy，零重启；10 个后端实际 Settings 的 Yahoo 开启、代理存在，采集为 stream、JIT off。AAPL 元数据、59 根 D1 和报价读取通过。生产登录、图表、回放、设置和手机视口检查通过；工作区、偏好、组合、告警配置、账户和通知指纹保持，没有密码变更或通知测试。

EURUSD 平台 M1 + Python Supertrend 完成约 18 分钟观察，原生数据采样 1071 秒、4521 次，跨 18 个分钟，0 reset、0 柱时间回退、0 柱数量缩减、0 空数据和指标采样、0 页面错误／失败响应。Canvas 采样没有全空或蜡烛消失事件。Ubuntu 浏览器在并行工作负载下出现最长约 6.5 秒的渲染间隔，不能据此承诺稳定帧率或逐帧无闪；本次没有视频逐帧结论。

启动后日志有 4 次上游 ReadTimeout，以及 8 次预期取消对应的 CancelledError；没有 OOM 或服务重启。原始记录保留，不能描述为零网络故障。该观察实际为 stream，不是 REST 证据。

## 地址与控制

运行主机：Unraid `192.168.7.33`，目录 `/mnt/user/appdata/market-watch`，Compose project `market-watch`。主站 `https://trade.kookvv.com:8443/`，图表 `https://charts.kookvv.com:8443/`。

```bash
cd /mnt/user/appdata/market-watch
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build
./tools/docker-compose -p market-watch -f compose.release.yaml stop
```

保留 v1.25.4 镜像、最终 dump／配置归档及 `deploy/oanda-rest-v1.25.7-switch-20261015/rollback.sh`；回退按用户授权和异常检查点执行。后续无 schema／依赖／持久格式变化的小补丁，用户明确选择复用这次已验证备份和恢复证据，只增加配置留档及必要回归、上线检查，不重复全库备份和完整恢复／回退演练。

固定镜像及 standalone 配置见 [发布清单](../deploy/releases/v1.25.7-production.json)；净化证据和校验见 [index](verification/oanda-rest-v1.25.7-production/index.json)。不提交凭据、env、dump、原始日志、视频、截图或许可库。原标签不移动，生产证据由后续提交归档。
