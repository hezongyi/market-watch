# 自建详情与搜索提示精简验收

2026-11-14，分支 `feat/managed-live-rollover-20261113`、基线 `17af8e25` 上实施[已确认方案](../../plans/pending/mobile-managed-details-simplification-20261114.md)。保留工作树中此前实现与未提交修改。风险 F0：兼容增加只读范围字段、修改手机展示及加入分组默认值；无 schema、数据格式、采集/聚合或实时流变更，采用本地回归与 Ubuntu 隔离 R1。

## 实现与证据

- 详情直接显示一个品种级历史起止范围。M1/D1 派生取实际已发布基础产物；原生多周期取最细可用周期。范围来自该产物的物化块，不使用维护目标或跨周期极值；无块返回空。保留存储的半开端点，界面统一 UTC 日期，不对所有周期减一分钟，也不承诺区间逐根无缺口。
- 生成方式、口径、复权和日界分别用已有 shadcn Badge 展示。仅显示适用且有依据的属性；未知值不猜为 bid/NY17。删除“数据明细”整段与“默认自选列表”选择器；维护设置、固定版本、图表、实时操作和必要异常保留。
- 加入自选读取当前账号及服务器的 `watch-group`；全部/已删除选择回落首组，无组创建默认组。按最新偏好防重、保留409冲突处理，重新打开详情正确显示已加入。分组写入验证仅使用明确HTTP夹具。
- 自选搜索、添加自建均移除缓存读取提示及占位，保留缓存即时回显、实际错误/重试、离线写保护和独立目录同步状态。两处缓存→新结果使用 MutationObserver 检查无瞬时提示，搜索框刷新前后纵向差小于1px。
- 此前放大的列表 Switch 仍为44×26px。本次未修改自选代码/价格栏、sparkline几何、采样、颜色或连接生命周期；A股横轴铺满仅分析，尚未实施。

验证全部通过：

- [完整前端构建](build.log)、[后端15项测试](backend-test.log)、[事实检查](managed-facts-test.log)、[数据页面回归](data-test.log)、[搜索回归](search-test.log)。相关命令为 `npm run build`、`PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest backend/tests/test_data_center.py -q` ，以及分别执行 `node tests/mobile-managed-facts.cjs`、`node tests/mobile-data.browser.cjs`、`node tests/mobile-symbol-search.browser.cjs`。
- [数据全流程17组检查、56张截图](workflow-test.log)，覆盖创建/维护/实时直接开关、丢失响应、失败、离线、未保存退出，以及本次当前/全部/已删除/无分组、防重和冲突重试。见[检查清单](workflow-proof.json)。完整临时截图在 `/tmp/mw-detail-simplification-workflow`，仓库保存选定详情截图；夹具不代表真实供应商或真机。
- Ubuntu真实实例只读打开5个已有品种，范围响应与该版本/周期的已发布物化块独立SQL核对全部一致，见[范围核对](storage-range-proof.json)。未为验收修改用户分组、创建品种或切换实时开关；应用自动行情订阅、读取/准备缓存请求在[运行证据](runtime-proof.json)单列。
- 375/412px、深浅主题、14/21px字号共8种详情截图：标签自然换行，日期可读，无水平溢出；两页真实搜索也截图检查。浏览器无脚本异常，API源码与web资源SHA-256均和当前构建一致，见[运行日志](runtime-test.log)及[运行证据](runtime-proof.json)。
- APK更新清单200，0.1.3包大小与SHA-256一致。此次只改服务端及WebView资源，无需安装新APK。Android输入法、原生返回/触摸仍需用户实机复核，浏览器窄视口不能替代。

截图：[实际详情浅色](screenshots/detail-light-412-14.png)、[实际详情深色大字号](screenshots/detail-dark-375-21.png)、[添加自建搜索](screenshots/create-search-light.png)、[自选搜索](screenshots/watch-search-light.png)、[外汇独立标签夹具](screenshots/fixture-05-detail-ready.png)。同目录保留全部8种真实详情布局。

## 实际运行与回退

- 主机：Ubuntu quant-server 本机 Docker。沿用本任务隔离 project `mw-managed-live-rollover-20261113`、独立数据库与网络；未在Unraid启动或修改实例。部署前磁盘41GiB空闲、内存约4.8GiB available，本次只替换已有api/web，不增加数据库或worker。
- 验收地址：<https://192.168.7.232:18447/m/data>。
- 启动：`/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh`。
- 停止：`/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh`。
- api：`sha256:ef51751b121e3ca22699aec250953c8070ce0873c328c9379d43f27c1058b529`。
- web：`sha256:156693d60d11af3f506d39233ce86917c295d177c9b5128d8718389a4de2ebe0`；shell：`a57f2d8f76d26e15`。
- 两个候选使用 `mw-docker build`，task/project均属本任务、purpose为acceptance，标签分别 `market-watch-api:mobile-detail-simplification-20261114`、`market-watch-web:mobile-detail-simplification-20261114`。仅 api/web 更新到固定ID，data-worker、market-runtime、PostgreSQL未变。
- 私有目录中 `run.json`、`compose.json` 均保留 `*.before-detail-simplification-20261114T143829Z` 备份，downloads只读挂载完整保留；凭据、私有配置未纳入仓库。
- 回退：从上述备份恢复api/web旧镜像（api `sha256:25e2db4b3ba1a60ad5547b5649395d82a53e803d619cca875bc100436a54975d`，web `sha256:a6eff5d542f9bde89cf3a1549781ce76286f6d613ea69330d20f206225daf6f1`），仅对本project执行 `docker compose -p mw-managed-live-rollover-20261113 -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json up -d --no-build --no-deps api web`。无数据库迁移，不需数据库回滚；旧镜像保留。
- 未运行远端CI、更新PR、commit、合并、正式tag或生产发布；18443未修改。后续正式发布仍按仓库检查点执行。

后续数据页清除筛选按钮已改为无框叉号，当前web镜像及截图见[图标调整记录](../mobile-clear-filter-20261114/README.md)。
