# 回测统一自建搜索与固定版本选择

日期：2026-10-07，前置 `a69c497`，分支 `feat/market-data-integration`。

## 行为

- 回测默认自建行情，通过统一 `/series/search?kind=history` 搜索已发布来源系列。
  结果显示准确品种、来源、Bid和NY17/UTC日界，同名不同来源/日界分别保留。
- 选中数据集后显式选择发布版本和区间，不直接用搜索结果的最新版本启动。
  数据集级加载版本，避免全局最新100条挤掉其他数据集；深链接直接读取指定旧版本，
  并保留该版本，即使它不在该数据集最近100条中。更多历史版本仍可从数据中心链接进入。
- 搜索更换、失败或无结果时不替换既有输入。请求取消/过期结果不覆盖新搜索；
  待准备/缺映射项给出数据中心进度/维护链接。纯搜索不创建实时需求。
- M1及所选周期+D1发布核验继续作为提交门槛，提交固定版本、来源数据集、周期和区间。
  已存回放可恢复，旧版历史入口显式保留，不静默解释为组合或固定版本。
- 桌面窄窗口版本/时间字段换行，完整所选版本范围在正文可见；普通键盘原生select、
  有标签的search输入和状态反馈沿用现有视觉体系。未增加移动端范围。

## 验收

- 最终前端TypeScript/Vite构建通过，既有>500kB chunk提示保留。
- 真实Ubuntu浏览器默认自建、搜索来源/日界、显式版本、无结果保留选择、兼容入口、
  数据中心深链接、保存回放恢复及固定输入导出通过，无pageerror。
- 实际Dukascopy和OANDA H4回放OHLC、确认/覆盖等字段与各自固定图表产物逐项一致；
  输入清单保留正确父M1及周期产物，不显示未来柱、不产生实时需求。
- 1024/1440/1920、键盘和200%内容缩放通过；截图复查后扩大版本/日期字段最小宽度，
  追加完整所选版本文字，再构建和实际复验。

脚本 `web/tests/fixed-replay-real.browser.cjs`；ignored证据
`replay-series-search-build-final.log`、`replay-series-search-browser-closed.log`、
`fixed-replay-browser-real.json`、`fixed-replay-higher-real.json` 与三宽度截图。

## 环境与范围

Ubuntu独立Compose `market-watch-three-layer`，访问 <http://127.0.0.1:16629/replay>。
web只读挂载当前 `web/dist`，构建后实际使用新前端；API沿用固定周期回放实现，数据库迁移aj37。

```sh
VITE_ADVANCED_CHART_ORIGIN=http://127.0.0.1:16630 npm --prefix web run build
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml up -d --no-deps web'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml stop web'
```

尚需新策略默认组合搜索/旧Watch完整输入接线、更多来源参数设置、3–10品种并发和恢复验收。
完整A–E目标未完成，48小时新三层观察未启动；不推送/PR/生产发布或下单，MT4后续。
