# 自选页：三行间距与上一交易日灰色曲线

分支 `feat/android-personal-v205`，基线 `2ab24ef7`，base 为 v2.0.7。F0：增加兼容的 sparkline 响应字段并调整自选页，无 schema/持久数据迁移。按用户要求只做本地检查和 Ubuntu R1，不更新 PR、不运行 CI。

## 行为与边界

代码、中文说明、供应商保持三行。代码至说明间距 3px、说明至供应商 2px；次要文字保持 11px，行高调整为 1.35。72px 行高、42px 图高和左右固定列保持；375px/412px 屏幕图宽分别约 184px/221px。

Yahoo 明确标注 EQUITY/ETF/INDEX、交易所时区及 `0930-1600:23456` 的品种，按交易所本地日期选择实际存在的最近交易日曲线。当天任一周期有有效数据，优先于较早的 M1 数据；否则保留最近有数据的日期，不按“昨天”猜交易日。查找限最近 14 个日历日、每周期最多 1600 点，不跨身份使用缓存。期货、外汇、加密及自建/组合维持原窗口规则。

旧曲线折线和面积使用现有无更新状态的灰色，不再显示“上一交易日”文字。曲线内增加该交易日实际开盘价参考线，只有缓存首点就是开盘点时才显示；没有可确认的开盘价时省略该线。保留完整 42px 曲线高度。收到本日数据后恢复涨跌配色和本日 09:30–16:00 时间轴，未到时间留白。缺数据不被解释为休市或节假日；本轮按反馈一并移除旧曲线下方的等待提示，保留灰色及自动切换。

响应新增 `session: {date, previous}`、`session_open_price`、`valid_until`，区分绘图区间与缓存到期时间。前端读取快照、加载响应和定时器共用有效期规则，已收盘曲线不会被旧的 `window_end` 检查丢弃。上一交易日或空白股票历史不标记为“今天已经准备完”，下轮刷新仍能取得当天首批延迟数据。冷启动历史请求至少覆盖 390 根实际 M1 记录，沿用共享读取器跨周末/闭市取数，不创建后台任务。

## 检查与截图

- 原实现回归复现：周末/开盘等待时无曲线，UTC 零点后丢失美股当日数据，冷启动取数不足；对应测试先失败、修复后通过。
- `PYTHONPATH=backend python3 -m pytest backend/tests/test_sparkline_sessions.py backend/tests/test_sparklines.py backend/tests/test_sparkline_backfill.py -q`：27 passed（开盘线补丁后）。包括周一仍用周五、真实缓存跨周末、DST、晚间纽约日期、当前粗周期优先、过旧缓存拒绝、非股票行为和批量只读边界。
- `ruff check backend/alerts/sparklines.py backend/tests/test_sparkline_sessions.py` 通过。
- `npm --prefix web run build`；web 目录下 `node tests/mobile-sparklines.cjs`、`node tests/mobile-watch-a07.browser.cjs` 通过。浏览器含 8 组布局、窄屏/大字控件、下拉刷新及旧曲线→等待→当天切换；状态场景分别覆盖 375/412、深浅主题。旧曲线颜色与 muted 小字一致，无错误的昨收线，当天切换后未来时间留白。
- [前后实盘截图](a07-feedback/watch-stock-session/comparison.jpg)：时间不同，报价数值/走势变化不作为像素比较依据。[当前浅色](a07-feedback/watch-stock-session/live/light-375.png)、[当前深色](a07-feedback/watch-stock-session/live/dark-412.png) 已逐张查看，左侧三行及灰色曲线清晰，价格没有侵占图宽。
- [模拟灰色历史曲线与开盘线](a07-feedback/watch-stock-session/session-open/session-previous-light-375.png)、[模拟深色状态](a07-feedback/watch-stock-session/session-open/session-waiting-dark-375.png)、[模拟当天到数](a07-feedback/watch-stock-session/session-open/session-current-light-375.png) 均已查看。模拟证明状态切换，尚非实盘开盘后到数观察。
- 实盘 API 中 NVDA/AAPL 均返回 2026-11-11 的 389 个实际观察点及 `previous=true`，没有补造缺失分钟。[响应摘要](a07-feedback/watch-stock-session/live/stock-sessions.json)。实盘开盘线截图见 [session-open](a07-feedback/watch-stock-session/session-open/light-375.png)。四组实盘布局均无 pageerror，图宽一致，三列居中；报价/历史各两个请求挂起时下拉仍约 1.9 秒收起。[实盘测量](a07-feedback/watch-stock-session/live/proof.json)。

## Ubuntu 验收运行

实际主机 `quant-server` / `192.168.7.232`，project `mw-android-personal-v205`，地址 <https://192.168.7.232:18445/m/>。资源检查可用内存约 9GiB、磁盘 23GiB，复用隔离项目及端口；只替换 api/web，不新增服务，不重置数据库/自选，不操作 Unraid。

用 `mw-docker build` 明确指定本任务、project、`--purpose acceptance` 构建；运行镜像固定：

- API `sha256:35b1bdd69874f32e00c84895906cc4bbe5bf8ce383a1dcd4e2ee45036631c0aa`
- Web `sha256:34601452252bc9e6764788093949094a8c739f60e11c39d655e3ff14fae6652c`
- shell `03320bf55fcc5372`

本轮开盘线补丁备份 `before-watch-session-open-run.json`（0600）；回退本补丁可使用此文件代替下方原始留档。

私有配置目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`；替换前留档 `before-watch-stock-session-run.json`，权限 0600，旧镜像保留。凭据及配置不提交。

已执行启动/更新命令：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait api web
```

停止本轮服务（留档，未执行）：上述 compose 参数后改为 `stop api web`。

配置回退（留档，未执行）：使用同项目、同 overlay，将第一个 `-f` 改成 `before-watch-stock-session-run.json`，运行同样的 `up -d --no-build --pull never --no-deps --wait api web`；回退无需变更数据库。

CA 校验 `/readyz`、shell manifest 成功，容器 healthy。现有 APK 通过“更多 → 检查更新”取得新壳；手机 WebView 最终显示及真实开盘后的自动切换仍待真机验收。

开盘线补丁检查：27 项后端回归、前端构建、单元和浏览器回归通过。新 [实盘测量](a07-feedback/watch-stock-session/session-open/proof.json) 验证 NVDA 开盘价 172.72000122070312、AAPL 349.5849914550781，对应源记录保留原精度；四组布局无页面错误、历史曲线无日期小字。
