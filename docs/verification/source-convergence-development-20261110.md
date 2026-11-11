# 目录入口收敛：开发实例更新与复核

2026-11-10 05:36 UTC，Ubuntu `quant-server` / Compose project `mw-dev`。

- 地址：https://192.168.7.232:18443/
- 业务候选：PR #126，`f128d61a83ecc94a1d25b5918f03daac6ed50976`，包含目录与维护入口收敛，以及原生价格口径展示修正。
- 开发集成提交：`70c039fb104a5c23ba554b8595c49106e149c790`。API/worker 使用开发工作树源码；前端沿用已同步的 Vite 和原生图表资源。
- 风险分类 F0：兼容展示与入口收敛；没有 schema 或数据格式迁移。

## 实际服务复核

以真实开发服务完成浏览器表单登录、保存布局打开、图表渲染、商品搜索、自选添加弹窗和数据中心平台目录检查。没有替换接口或行情返回。

- 商品搜索与自选添加均请求 `/api/market-data/series/page`，`page_size=50`、`include_total=false`；未请求旧列表接口。
- 平台目录首批加载 50 行；打开目录没有调用供应商目录刷新。
- 浏览器核对 `000001` 的新浪与腾讯来源显示；实际元数据核对 `RB0`、Yahoo `GC=F`、Binance、自建、组合。固定历史展示为“自建”。
- 三种 OANDA 原生口径（买价、卖价、中间价）配置后与解析接口返回完全相同的元数据。
- 兼容列表接口与分页接口的首批结果相同。
- 实际服务原生图表资源清单与开发部署清单一致；浏览器脚本异常 0。
- 六类供源（OANDA、Binance、Dukascopy、Yahoo、AKShare、FXCM）各成功读取 40 根真实 K 线。
- 38 个后台角色均无 missing/stale/degraded/failed 状态和错误类型。通知测试获得服务端接收回执，不代表手机投递验收。

更新时 API 自动重载曾停在等待现有长连接退出的阶段，新请求超时；定向执行 `mw-dev restart api` 后重新完成以上全套复核。后台运行组已定向重启，挂载源码摘要与候选一致。当前不是长期稳定性或生产规模性能验收。

## 验证与证据

本地 native-series、presentation、provider-chart、series-access、platform/history catalog 回归 174 passed；目录兼容与维护相关回归 54 passed；Ruff 和 diff 检查通过。

最新候选的 GitHub Actions：https://github.com/hezongyi/market-watch/actions/runs/42762599646 。记录时 Web/Compose/变更分类通过，Backend 仍在执行；不将本地结果表述为远端 CI 已全部通过。

私有证据保存在 `~/.local/share/market-watch-dev/evidence/`：
`source-convergence-browser.json`、`source-convergence-browser.cjs`、`source-convergence-chart.png`、`source-convergence-directory.png` 和 `development-smoke.json`。

复核命令：

```bash
python3 deploy/ubuntu/development_smoke.py
node ~/.local/share/market-watch-dev/evidence/source-convergence-browser.cjs
mw-dev status
```

启停：`mw-dev up` / `mw-dev stop`，保留开发数据；定向重启 API 使用 `mw-dev restart api`。
本次只更新开发实例，未合并 main 或发布生产。
