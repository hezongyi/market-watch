# 告警选品筛选部署修复

## 问题与行为

用户在开发实例添加告警时，仍看到未开启实时的自建品种。实际 HTTPS 请求已带 `alert_eligible=true`，但运行中的 API 镜像没有该参数的实现，返回全部 14 个自建品种，其中 10 个实时未开启。前端测试及部署通过不能替代真实后端接口验收。

选品接口现在在计数和分页前要求同时存在工作区实时接续映射，以及 `managed_realtime` 已保存的启用选择。不再将 `Instrument.enabled` 的底层采集标记作为告警选品资格。默认数据列表不受此筛选影响；选定品种后仍核验具体周期、模式的 capabilities。

分类 F0：兼容的只读 API 参数与列表筛选，无 schema 或持久格式变更。

## 验证

- 新回归先失败：仅底层 `Instrument.enabled=true`、尚未保存自建实时开关时，旧筛选错误返回 1 条，预期 0 条。修复后通过。
- `PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest -q backend/tests/test_dataset_summaries.py backend/tests/test_live_api.py backend/tests/test_rolling_range_squeeze.py`：43 passed。
- Ruff、`git diff --check` 通过。
- `cd web && MOBILE_ALERT_OUTPUT=/tmp/mw-alert-picker-fixture-20261116 node tests/mobile-alerts.browser.cjs`：通过，含选品空态和实时未启用品种排除。
- Ubuntu 本机 Docker `mw-dev`，`https://192.168.7.232:18443`，严格 CA HTTPS 实测：普通列表总数 14；告警选品总数 4；每页 1 条的分页、末页、搜索均正确。样本为 EURUSD、USDCAD、USDJPY、XAUUSD，不将这组动态数据写成固定业务规则。
- 真实部署的 375px 手机浏览器只读验收：选品列表与服务端符合条件的集合完全一致；搜索未启用的 BTCUSD 得到空态，搜索 EURUSD 得到一条，清空恢复四条。API 业务写入拦截，未创建或修改真实规则。
- APK 更新清单仍返回 200。API 外所有容器的 ID 与启动时间不变；既有规则 ID、状态、版本、控制修订、run 保持不变。

## 部署与回退

API 镜像通过 `mw-docker build` 创建，task `mw-alert-picker-20261116`，project `mw-dev`，purpose `development`。

- 新 API image：`sha256:5a3e4e73cd5bc22c6e4f58754108aa2f5d3222f133f09f61c8b4b6c5bb1cd1bb`。
- 旧 API image：`sha256:22c9c97e88e44417cba89312c2820e61bbffd62c1d86755e094606724f6694dc`，保留。
- 实际运行与 `mw-dev` 操作入口使用的私有配置同步更新：`~/.local/share/market-watch-dev/updates/mobile-alert-steady-monitor-20261116/run.json`；仅替换 `services.api.image`。
- 启动：对上述配置执行 `docker compose -p mw-dev -f <配置> up -d --no-build --no-deps --wait api`；停止仅 API：`mw-dev stop api`。无需操作数据库或后台 worker。
- 私有配置备份、容器前后证据、真实截图和浏览器检查结果：`~/.local/share/market-watch-dev/updates/alert-picker-20261116/`。凭据及完整私有配置不提交。
- 回退仅恢复当前配置的 `services.api.image` 为上述旧 image，再执行同一 API 启动命令；不整体恢复配置，不覆盖后续 Web、证书或下载目录调整。

本次未改 Android 外壳，无需重新安装 APK。已打开的旧列表需重新加载页面或重开 App 后读取新结果。桌面触屏浏览器验证不替代 Android 真机验收。
