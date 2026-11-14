# 手机验收反馈修复 · 2026-11-14

分支 `feat/managed-live-rollover-20261113`，基线 `fc4bb5ad`。F0：手机搜索精简、兼容的参考价/错误字段及既有 Dukascopy 连接池的有界恢复；无 schema 或身份迁移。没有更新 PR、跑远端 CI、合并、正式 tag 或操作 Unraid。

## 已实施

- 自选搜索为搜索框 + 原生/自建合并列表。移除原生/自建标签、“全部来源”及列表/详情中的“添加到”。共用三行信息保留供应商与轻量自建标识，数据页的原生创建目录和必要筛选不变。
- 默认加入手机当前组；全部自选落首组，无组创建“自选列表”。重复按实际组判断，成功提示组名，桌面 active 与未知偏好字段保留。连续添加、详情返回位置和关闭停读沿用。
- 两个目录并行读取，分别保留 cursor/offset 与 page；一侧末页后继续另一侧。每批排序后追加，不重排旧行、不承诺全目录全局排序；一侧出错整批显式重试，不悄悄漏掉另一身份。
- 原生回显参考线优先同源、同窗口的 D1 open，也可用真正从窗口起点开始的原生柱 open；不把较晚的第一根 M1 当开盘。OANDA / UTC0 Binance 缺可靠基准时，经既有 prepare 精确补一根 D1，并通过 canonical cache writer 保存。
- 真实环境发现 OANDA 高周期缓存会把游标夹到旧日，导致旧日线被判为已满足。当前用精确日期 + 有界 revalidate 避免跳过目标日。回归测试用实际缓存播种旧日并复现 satisfied，再验证真正取回目标日。
- Dukascopy 可重试网络错误最多轮换一次托管池，保持同一绝对 deadline、来源限流及 TLS 校验；自定义客户端不重试，证书失败、429、不足预算不重复请求。
- 供应商历史补取失败显示“历史补取失败”，普通空观察不抹掉提示；下拉刷新可主动重试，成功会清除。有效旧曲线仍保留，身份变更/不可用不继承错误。
- 未修改 sparkline 几何、M5 采样、渐变、SSE 生命周期、网页图表策略与维护/实时开启流程。

## 检查结果

本次均通过：

```sh
PYTHONPATH=backend pytest -q backend/tests/test_sparkline_rollover.py \
  backend/tests/test_sparklines.py backend/tests/test_sparkline_sessions.py \
  backend/tests/test_sparkline_backfill.py backend/tests/test_provider_dukascopy.py
# 77 passed
cd web
npm run build
node tests/mobile-sparklines.cjs
node tests/mobile-sparkline-session.browser.cjs
node tests/mobile-symbol-search.browser.cjs
node tests/mobile-watch.browser.cjs
node tests/mobile-data.browser.cjs
MOBILE_DATA_OUTPUT=/tmp/mw-mobile-feedback-workflow-20261114 node tests/mobile-data-workflow.browser.cjs
MOBILE_VISUAL_SCOPE=identity MOBILE_VISUAL_OUTPUT=/tmp/mw-mobile-feedback-geometry-20261114 node tests/mobile-watch-a07.browser.cjs
```

- 合并搜索：两侧独立页链、50 → 77 → 83 行到底；同代码多来源/原生自建不合并；当前组变更、跨组重复、连续添加、旧响应隔离、失败重试和详情返回。
- 375/412px、深浅主题、150% 字号截图已比较；自选身份/几何8组保持。数据全流程14组、55张截图通过；创建/维护/实时开启/冲突/离线/减少动效未回归。
- 错误提示浏览器检查使用真实下拉动作，验证手动刷新绕过准备退避；切页不会绕过既有退避。该检查不代表 Android 真机手势验收。
- 搜索截图见同目录；完整测试临时证据在上述 `/tmp` 目录。

## Ubuntu 验收实例

- 实际运行：Ubuntu `quant-server` 本机 Docker，project `mw-managed-live-rollover-20261113`。
- 地址：<https://192.168.7.232:18447/m/watch>；数据页 `/m/data`。
- 仅重建/重启本任务 API 与 web，未重启 DB/workers，保留旧配置和旧镜像。
- 启动：`bash /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh`
- 停止：`bash /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh`
- 当前镜像 ID、源/容器 hash、线上/本地 JS/CSS hash 见 [runtime-proof.json](runtime-proof.json)，mobile shell `a289b437da7e6781`。
- 真实浏览器 smoke 通过：六个自选中的五条真实曲线、OANDA 开盘线、Dukascopy 明确失败提示、两页搜索入口、真实目录、深浅主题；零浏览器异常，未修改真实自选或创建/维护配置。截图为 `live-*.png`。
- OANDA USD_CAD 真实 prepare：HTTP200，1435点，open `1.42566`；GBP_USD open `1.32355`，XAU_USD open `3878.935`。实际六个自选响应摘要见 [real-sparklines.json](real-sparklines.json)。

## 未完成项与边界

**Dukascopy USDCAD 尚未通过真实数据验收。** 初始 API 出现 PoolTimeout，连接池轮换后可退出坏池，但最新真实请求仍 ConnectError / TLS EOF，约10.4秒后返回 retry、0点。独立进程、配置代理路线、显式直连以及本机 curl 均复现 TLS EOF；此前独立请求有一次返回1440点，不能将这次偶然成功当稳定恢复。当前没有切换供应商、修改代理配置、降低 TLS 验证或伪造曲线。外部链路恢复后需复验，整体不标“全部完成”。

Dukascopy 黄金存在曲线但缺 NY17 开盘柱；其原生日线 UTC0 与 NY17 窗口不一致，不能套用 UTC 开盘画线，因此暂不画不可靠参考线。OANDA 黄金已使用匹配窗口的真实 D1 开盘线。

用户已反馈首轮多数项目正常；系统返回键原测试第7项未单独反馈。本轮新增合并搜索与错误状态仍待 Android 实机复核。Yahoo 在本隔离实例保持原先禁用，Yahoo 时段结论来自来源夹具，不声称本轮真实 Yahoo 验证。

本地 `market-watch-mobile-ui` skill 的共享搜索约定已同步此次用户决定，`skill-creator` quick_validate 通过；skill 位于仓库外，不随本 commit 分发。
