# Market Watch v1.2.0 本地交付

## 范围

本轮为独立Advanced Charts图表模块及按需行情接入，在Ubuntu Docker验收。原轻量图表、监控、演练保留。源码位于`/home/quant/repos/market-watch-advanced`的`feature/advanced-charts`；原仓库和Unraid生产服务未切换。远端由用户自行push。

功能及逐项证据见[验收清单](advanced-charts-current-acceptance.md)，日常使用与边界见[使用说明](advanced-charts-user-guide.md)，Python扩展见[指标维护](python-chart-indicator-maintenance.md)。

## 已验证

- 原生桌面最多八图，布局/分隔线、平移缩放、同步、绘图/模板/收藏与服务端保存恢复。
- 首发EURUSD/XAUUSD/BTCUSDT及OANDA支持目录；九周期，D1以下优先、W1后台排队、MN只用已有日线。
- NY17/UTC0及维护时区来源；完整休市窗口显示休市前行情并提示，回到交易窗口恢复同步。
- 比较、多价格轴、百分比、数据窗口、内置指标及Python桥；代表性绘图和指标数值对照。
- 手机单图只读且不写回桌面设置；K线/报价/需求续期失败恢复；八图轮询无积压；原工作台回归。
- 后端175项及隔离PG14补跑7项共182通过，适配器18组通过。最终日志在`docs/evidence/release-20260930/`；浏览器专项范围详见交付核对。

## 已知边界

1. 两个供应库缺件不补包：CSV及样式保存使用顶部替代入口；原生入口仍可能不可用。CSV不含原生内置指标值。
2. 无Pine执行、交易/策略回测、图上预警、新闻/深度及成交量输入。桌面账户管理器保留，未接Broker时展开为空，使用说明已标注。
3. Python插件不是任意Python图形自动转换：输入/参数类型及五位显示精度边界见维护文档。
4. 月线不自动大范围补数；未知历史缺口不视作休市/源头起点。补数受上游、代理、队列限制，无固定耗时保证。
5. 原生比较线可以跨休市连接点，不意味着期间存在交易。未逐项审计供应库所有绘图/指标算法。
6. 本地自签HTTPS与回环端口不等于公网部署；许可库文件不入Git，换构建机须另行安装授权包。

## 本机查看

Ubuntu本机浏览器打开`https://localhost:15443/advanced-charts`；图表独立来源`https://127.0.0.1:15444`。测试使用自签证书，登录沿用现有开发管理员账户。服务仅绑定回环地址，通知投递关闭。

## 启动与回退

在本源码目录，确保既有`/tmp/mw-docker-acceptance/`中的凭据及TLS文件仍存在；这些文件不入Git，丢失时按[本机容器验收](../deploy/local-container-acceptance.md)重建。以下不操作生产：

```bash
export MW_ACCEPTANCE_ENV=/tmp/mw-docker-acceptance/api.env
export MW_ACCEPTANCE_DIR=/tmp/mw-docker-acceptance
set -a
. deploy/releases/v1.2.0-local.env
set +a
docker compose -f compose.acceptance.yaml up -d --wait
docker compose -f compose.acceptance.yaml restart tls
```

旧终端未刷新docker组可用`sg docker -c '命令'`，不需要sudo。

本地回退到版本整理前的验收镜像：

```bash
export MW_API_IMAGE=market-watch-api:acceptance-closed-session
export MW_WEB_IMAGE=market-watch-web:acceptance-closed-session
export MW_CHART_IMAGE=market-watch-chart-origin:acceptance-visible-entries
docker compose -f compose.acceptance.yaml up -d --wait
docker compose -f compose.acceptance.yaml restart tls
```

上述回退基线与1.2.0之间没有数据库迁移，仅版本整理；不据此推断v1.1.0或任意旧版本可以直接操作新库。切换其他结构版本前按备份/迁移手册验证，不能用生产库试错。重新加载`.env`清单即可恢复1.2.0。

镜像ID及构建源码提交见[发布清单](../deploy/releases/v1.2.0-local.json)。主站镜像内固定本机图表origin；未来上线需按[隔离图表部署](../deploy/advanced-chart-origin.md)重新设置公开origin并构建，不能将本地镜像直接当生产配置。
