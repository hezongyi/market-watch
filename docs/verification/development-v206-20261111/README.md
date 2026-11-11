# 开发实例 v2.0.6 修复与部署验收

2026-11-11，Ubuntu `quant-server` 的持久开发实例 `mw-dev` 已升级到
v2.0.6 / `d2a3e0925175376746170e2597c6fa675d2fa43d`。
主线及正式 v2.0.6 标签均指向该提交。风险 F0：既有兼容补丁部署与静态资源修复，
没有新增应用代码、数据库迁移或持久格式变更；最小检查采用真实实例 HTTP、浏览器和运行组 smoke。

## 故障与修复

1. 实例原先挂载 `market-watch-dev-v2.0.5` / `1bb935bd`，并未部署 v2.0.6。
   实际登录后 `GET /api/health` 返回 500，日志为 PostgreSQL `GroupingError`。
   v2.0.6 复用 JSON execution-state 表达式的补丁已进入新镜像及源码挂载。
2. 实际浏览器登录后显示“图表界面接入未完成，请重新加载”。
   图表库目录是指向宿主机另一工作树的绝对符号链接，容器无法解析，页面加载请求返回 404；
   直接请求还可能被 Vite fallback 返回 200 HTML。因此只检查状态码或 manifest 不足以验收。
   从完整新建 web 镜像提取真实文件，确认整个资源目录没有符号链接，并检查资源 MIME 与实际图表加载。

新增 `web/tests/development-deployment.browser.cjs` 已在修复前运行失败：
`AssertionError: text/html does not match /javascript/`；修复后通过。
同一脚本还验证图表数据响应、可见 OHLC、数据中心、健康查询及 worker 状态。

## 实际部署

- 主机：Ubuntu `quant-server`，项目 `mw-dev`。
- Web：<https://192.168.7.232:18443>；ntfy：<https://192.168.7.232:18444>。
- 工作树：`/home/quant/repos/market-watch-dev-v2.0.6`，分支 `fix/dev-v206-20261111`。
- API 与三个 worker：`market-watch-api:dev-v206-20261111`。
- Web：`market-watch-web:dev-v206-20261111`。
- 两个镜像均经 `mw-docker` / `market-watch-ubuntu` 构建，task 为 `mw-dev-v206-20261111`；
  commit 标签均为上述 v2.0.6 提交。web 构建时工作树新增了验收文件，应用源码与标签一致。
- 保留 source/frontend 开发模式，挂载新工作树；原始配置、旧镜像引用及启动器留档在私有更新目录。
- 图表资源位于私有状态目录 `updates/v2.0.6-20261111/native-assets`。
  本机 `mw-dev` 启动器已更新 checkout、资源 overlay、重建 task 和镜像引用。
- PostgreSQL 14.24 与既有开发 volume 保留；迁移容器退出 0，schema head 仍为
  `bd57_notice_source_poll_index`。
- 另一个 dirty 开发工作树、其他任务实例及 Unraid 生产实例保持原状。

启动、停止与状态命令：

```bash
mw-dev up
mw-dev stop
mw-dev status
```

`stop` 保留数据库。凭据仍从 `~/.local/share/market-watch-dev/credentials.json` 本地读取。
旧配置及原容器 inspect 已私有归档；已有全库 dump 保留，本次没有重置或恢复数据库。

## 结果与复验

- [HTTP](http-result.json)：HTTPS 登录、健康接口、数据覆盖和已发布完整 K 线通过；
  5 个工作区、36 个偏好保留，健康接口返回 200。
- [浏览器](browser-result.json)：图表库及脚本类型正确，实际图表取得非空 K 线并显示 OHLC，
  数据中心打开成功；没有 page error 或失败的图表静态资源。
- [行情](source-results.json)：OANDA、Binance、Dukascopy、Yahoo、AKShare、FXCM 均读取到 40 根 K 线。
- [传输](transport-results.json)：MCP initialize、42 项 tools/list，两类 SSE 的首个事件或心跳、
  通知中心 health 与 ntfy health 均通过。
- 三个后台组共 38 个角色无 missing/stale/degraded/failed 或 error；
  空闲及 waiting_input 为现有需求下的正常状态。9 个常驻容器均 running，重启计数为 0。
- 以上为本次短时功能验收；没有发送新的外部通知，未验证手机收件或长期稳定性。

从工作树根目录执行：

```bash
python3 docs/verification/development-v206-20261111/http-smoke.py
NODE_PATH=/home/quant/repos/market-watch/web/node_modules \
MW_ACCEPTANCE_CREDENTIALS_FILE=/home/quant/.local/share/market-watch-dev/credentials.json \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
node web/tests/development-deployment.browser.cjs
```

`node --check`、Python 编译检查和 `git diff --check` 通过。
本次操作与验收仅面向用户指定的开发实例，不包含主线合并、生产发布或资源退役。
