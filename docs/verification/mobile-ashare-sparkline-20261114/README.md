# A 股 sparkline 使用完整交易时间横轴

2026-11-14，用户批准此前分析建议实施。F0：手机专用响应新增可选展示字段，兼容既有接口与本地缓存，无schema或共享采集变更。

## 行为与边界

- 根据真实来源身份识别AKShare沪/深/北A股；原生和有相同基础来源身份的自建共用展示规则。以实际展示数据所在的上海日期生成09:30–11:30、13:00–15:00两个坐标区间，压缩午休。此坐标不是节假日日历，也不据此宣称行情已更新或交易日已开市。
- 保留源时间time、价格、缺口和修订；可选display_time使用分钟线结束时间定位收盘价格，未闭合区间不超出观察时刻。来源9:30结束标签对应9:29起点的首根不会被裁掉。采集、存储、回填和图表页不改动。
- 前端以两个区间累计的4小时映射横轴。上午只占左半幅，下午从中点继续；未来交易时间留白、真实缺口断线，午休不补造价格。区间外观测不参与绘制或纵向缩放，午休报价不产生虚假尾点。
- 保留M5显示采样、当前报价即时尾点、折线/面积配色与纵轴缩放、昨收证据、旧日蓝线、固定列宽/行高及连接生命周期。美股/港股/期货/外汇/加密保持既有时间轴。日线专用品种仍不伪造日内图。

## 验证

- [后端66项](backend.log)：`PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest backend/tests/test_sparkline_a_shares.py backend/tests/test_sparklines.py backend/tests/test_sparkline_sessions.py backend/tests/test_sparkline_rollover.py backend/tests/test_sparkline_backfill.py -q`。覆盖原生新浪/腾讯、显示日期、首尾收盘标签、未闭合数据不画未来、自建基础身份、其他市场排除及既有回显/参考/回填行为。
- [前端逻辑](frontend.log)：`node tests/mobile-sparklines.cjs`，累计交易时间位置、午休过滤、数据缺口、纵轴不受盘外异常值影响、源M1尾点，以及原有取消/缓存/采样/实时报价检查通过。
- [专用浏览器](browser-proof.json)：`MOBILE_ASHARE_OUTPUT=/tmp/mw-ashare-sparkline-20261114 node tests/mobile-sparkline-a-shares.browser.cjs`，同一构建/数据对照旧24小时轴与新轴。10:30到25%、午休50%、14:00到75%、收盘100%；缺口保留、旧日蓝线、行列几何和美股SVG完全一致；375/412、深浅主题和150%字号截图通过，无页面异常。夹具数据不称真实供应商验收。
- [原会话浏览器](session-regression.log)：`MOBILE_SESSION_OUTPUT=/tmp/mw-ashare-session-regression node tests/mobile-sparkline-session.browser.cjs`，普通/早收盘、旧日切换、空响应、错误与离线回归通过。修正了此脚本切回自选后未等ResizeObserver恢复宽度就比较SVG的竞态，改为等待目标SVG稳定，未修改产品连接/尺寸逻辑。
- 构建、ruff及git diff --check通过。已人工查看旧轴/新轴/午休及真实运行截图。
- [真实Ubuntu](runtime-proof.json)：api源码和手机构建资源摘要匹配；真实腾讯原生寒武纪2026-11-13的240点，在同一前端函数中旧轴末点29.03%、新轴99.58%；最后一分钟缺失保留余白，不强拉满。实际页面绘制超过98%图宽，NVDA名称正确，无用户配置写入或页面异常。八组真实布局截图及APK更新包摘要通过。Android真机仍由用户复核。

对照：[旧24小时轴夹具](screenshots/legacy.png)、[交易轴夹具](screenshots/full.png)、[午休](screenshots/lunch.png)、[真实寒武纪](screenshots/watch-412-dark-14.png)。

## 环境与回退

Ubuntu本机Docker，project `mw-managed-live-rollover-20261113`；<https://192.168.7.232:18447/m/watch>。部署前磁盘41GiB、内存约4.9GiB available；仅更新api/web，行情runtime、data-worker、数据库保留。无需新APK。

候选均通过mw-docker build构建，task/project为本任务，purpose acceptance：api `sha256:e84772545ca5b36647f3edf6195136c34a5ea787616bc883890fd69415fe13b5`；web `sha256:fcc379e1ea0b59221679fd1e7db2a4b9c26f80a6bf5a2ea323e172ba601dc9a1`；shell `c3b5bb975dbf9299`。

私有状态目录 `/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113`。启动/停止使用该目录 `start.sh`／`stop.sh`；run.json、compose.json备份后缀 `.before-ashare-sparkline-20261114T152834Z`。回退时恢复api `sha256:92cd24d49aef909b1584cdaadb85434e297f1df6d6321ef1a80a3af9be287eae`、web `sha256:4a4f69806e0b273e58f3f90d0c44b8031a7dd0acfcf672ca8817c47c6f53e28a`，仅本project执行 `docker compose -p mw-managed-live-rollover-20261113 -f <私有状态目录>/run.json up -d --no-build --no-deps api web`，无需数据库回滚。

未操作远端CI、PR、commit、合并、正式tag、Unraid或18443。
