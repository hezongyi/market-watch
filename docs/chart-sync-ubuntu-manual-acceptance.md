# Ubuntu 图表同步人工验收实例

2026-10-04，在 Ubuntu `quant-server`（`192.168.7.232`）建立修复提交 `2041869` 的独立 Docker 实例。

- 工作台：`https://192.168.7.232:16143/advanced-charts`
- 图表来源：`https://192.168.7.232:16144/`
- 首次访问为自签名证书，需要分别打开两个地址接受证书；局域网可直接访问，无需 SSH 隧道。
- 独立登录凭据保存在 `/home/quant/repos/.acceptance/chart-sync-ubuntu-20261004/login.json`（权限600），不提交 Git。
- Compose及证书目录：`/home/quant/repos/.acceptance/chart-sync-ubuntu-20261004`。

Compose 项目 `mw-chart-sync-ubuntu-20261004`，独立网络 `mw-chart-sync-ubuntu-20261004_default`，独立卷 `mw-chart-sync-ubuntu-20261004_sync-pg`，独立数据库 `chart_sync`。未挂载生产数据目录，数据库无宿主机暴露端口，通知投递关闭，无worker。其他 Ubuntu 验收实例未修改。

API使用 v1.7.0发布镜像；web和chart由修复worktree在Ubuntu本地构建，标签 `mw-chart-sync-web:ubuntu-2041869`、`mw-chart-sync-chart:ubuntu-2041869`。web图表origin按上述局域网IP编译。PostgreSQL使用本地已有16-alpine镜像，新库独立运行迁移。真实行情沿用现有OANDA凭据及Unraid行情出站代理；业务容器、数据库和请求处理均在Ubuntu。

手动检查优先使用EURUSD，四图W1/D1/H4/M5，重点观察：

1. 开启时间与十字线同步，周线点击几年前有效K线；M5成功定位，没有永久loading或商品错误。
2. 点击后鼠标静止，加载完成时其他图十字线/日期标签已经对齐；再移动鼠标不应补跳。
3. 历史M5持续按住向新/旧方向拖动；鼠标按住期间就有K线移动，跨边界不永久空白、不回跳，柱宽保持。
4. 关闭时间与日期同步，两张M5分别最新/历史；操作历史图不影响最新图。
5. Alt+G日期对话框跳到2024-03-27，再回最新，后续仍可拖动。
6. 添加原生MA200/Python SMA200和画线，保存并刷新，历史位置与设置保持；日期同步开启时重复保存。

OANDA周日休市，实时变化可用BTCUSDT观察。异常反馈附商品、周期、同步开关、操作顺序；拖动截图注明鼠标是否仍按住。

已有完整修复验收范围和限制见[修复验收文档](chart-cross-period-sync-acceptance.md)。Ubuntu部署的浏览器原始记录保留在上述私有实例目录。

Ubuntu四图完整产品回归已通过：0 JavaScript错误，静止光标、历史窗口隔离、503/取消恢复、Python指标、持续按住10次边界、画线/价格轴/柱宽及保存重开均通过。原始记录为实例目录内 `product-ubuntu-v2.json`。首次记录在最终保存步骤失败，保留记录；同候选串行重跑全部通过。两个入口已从另一台局域网主机确认HTTP200。

人工验收反馈的“平台行情暂不可用”已定位到8秒行情请求预算不足：未缓存18000根EURUSD M5多页请求复现8031ms后503。仅此Ubuntu实例设置 `ALERTS_PROVIDER_REQUEST_SECONDS=25`；另一个未缓存日期18000根请求12547ms成功HTTP200，未缩减储备、未修改生产配置。证据见[预算对照](verification/chart-sync-acceptance/ubuntu-provider-budget.json)。
