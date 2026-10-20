# 通知细化 08–12 实施与验收（2026-10-19）

用户“将待改项，全部实施”授权后，在原分支 `feat/issue75-notifications-integrated-20261019`、原 PR #87 和原 Ubuntu 实例完成本轮实现。其他工作树、数据库及验收实例保留。源码基于 `ed77152`；本目录随本轮提交归档。

## 生效内容

1. 原生即时浮窗 X 点击盒恢复 34×34，SVG 18×18，右上角内缩 8px。保留图表原生 Dialog/NavButton，在呈现层增加 16px 位移、220ms 入场和 160ms 退场；换事件先退后进，同事件更新不重播。退出快照 inert，减少动态效果关闭动画。
2. 系统消息默认 3 秒，在设置选择 3/5/8/10/15/30 秒。既有 meta 键存储、本主体隔离、刷新记忆并同源广播；下一条采用新值，每条完全呈现后开始计时。悬停/焦点暂停，离开后完整时长恢复。交易仍必须确定，计时配置不确认或关闭交易。
3. 系统消息工具栏复用告警搜索/排序/三横点。搜索默认收起，不自动聚焦，点击输入没有聚焦框；关闭清关键词。筛选菜单直接三段，两个原生分隔线，各段全部只清自身；排序由后端游标查询覆盖全历史。低窗口菜单使用原生滚动并保留上下 8px 边距。
4. 警报/日志侧栏使用当前原生自选表的主题 token；覆盖仅在 `.chart-alert-panel`，保持创建/编辑弹窗、系统消息窗口和原生浮窗主题边界。
5. 列表与统一浮窗使用同一个三行时间组件。日期12px、列表时分秒13px、偏移12px；浮窗时分秒14px且仅该行橙色。列表全部正常文字色，数字等宽，无额外低透明度。现有日期分隔保留。UTC 毫秒不变，继续跟随激活图表时区。

## 风险与兼容

本轮 **F0 / R1**：兼容增加 `sort=newest|oldest`，默认最新在前；显式 newest 和旧默认游标指纹兼容，换方向的游标拒绝复用。排序按事件 UTC 发生时间和 ID 双键稳定比较，正序使用 `>`，倒序使用 `<`；事故合并选取、日期分组和底层记录不变。时长偏好仅在既有 IndexedDB meta 中加键，不改 schema。无告警调度、确认、排队或手机协议改动。原 PR 的 F1/R2 底座和先前时区/登录证据继续有效。

## Playwriter 证据

Session 7 登录原实例，真实数据库/供源。追加的独立浏览器 context 只复用登录 cookie，浏览器时区设为 `Asia/Shanghai`；不复制/清除用户 IndexedDB。原排查页及真实未确认交易保留，未点击任何真实交易确定。

- [工具栏与真实列表](12-list-utc-browser-shanghai.png)：日期/时间/UTC+0 三行，默认仅搜索图标；浏览器为北京时间。
- [聚焦中的搜索输入](13-search-focused.png)：不自动聚焦；点击后 input 及两层容器 computed outline-style=none、box-shadow=none。搜索不存在文本可显示无匹配，关闭后查询不再带 q。
- [三段筛选菜单](02-search-filters.png) · [最终低窗口菜单](14-short-menu-final.png)：恰好两条分隔线；600×400 中 top=8/bottom=392，原生滚动且 End 可定位最后来源。
- [完整历史正序连续加载](04-oldest-scroll.png)：从100条滚动到200条，全部 UTC 时间非递减，真实请求带 sort=oldest；同刻稳定双键和方向错误游标由后端测试补充覆盖。
- [设置默认3秒](03-settings-default.png)：实际原生选择器改5秒，刷新仍5秒，最后恢复3秒。不是仅修改预览 fixture。
- [即时浮窗深色](08-instant-dark.png) · [呈现阶段和几何结果](motion-results.json)：原生外壳 x622.5/y46/w355/h254，X34px、SVG18px，时分秒橙色。默认自动消失、悬停暂停/离开恢复、换条退场、旧内容不可交互、同ID不重播、退场取消与减少动态效果检查通过。该轮使用两条真实历史与只读呈现 transport，未新增事件、未修改业务队列或确认交易；结束后刷新恢复正常接入。
- [真实Runtime默认时长](live-duration-results.json) · [明确标记的系统验收样本](20-live-system-duration.png)：通过真实 fault → IndexedDB/Runtime → 图表桥接 → 原生浮窗 → dismiss RPC 路径，完全呈现后3176ms收起，设置为3秒。该样本明确标记为隔离验收，不是用户历史；一次后台页尝试未出现可见浮窗，切到前台后采用新样本通过。
- [筛选和时区结果](filter-time-results.json)：错误+连接+未读实际请求组合生效；全部只清state，全部级别只清severity，保留source。相同事件 UTC `2026-10-19T16:28:18.628Z` 在 UTC 显示19日16:28:18、上海20日00:28:18 UTC+8、纽约19日12:28:18 UTC-4，dateTime完全一致，跨午夜显示正确，最终恢复UTC。
- [320px窄屏](15-list-320.png) · [浅色列表](16-list-light.png)：面板client/scroll均296px，时间完整，三行实际12/13/12px、同正常文字色。
- [深色警报](07-alerts-dark.png) · [浅色警报](17-alerts-light-final.png) · [浅色日志](18-alert-logs-light.png) · [深色日志](19-alert-logs-dark.png)。深色自选表/告警底色均rgb(15,15,15)，文字rgb(219,219,219)；浅色均白底、文字rgb(15,15,15)。运行时切主题同步，最后恢复Dark，未保存布局。
- [焦点暂停与交易呈现](focus-trade-results.json) · [浅色交易浮窗](21-trade-instant-light.png)：只读呈现真实历史，焦点进入3400ms仍保留，移出恢复关闭；交易3500ms后仍保留，待确认计数更新不重播。浅色时分秒为rgb(155,75,0)，未发confirm-alert。该检查不修改Runtime队列，结束后恢复Dark并刷新正常接入。
- [最终尺寸/颜色/聚焦断言](final-ui-results.json)。早期01/05/06/09等图片保留当时真实场景，包含部署连接重建产生的系统消息；最终判据以本表对应后续图片/JSON为准，不把短暂网络错误隐藏或删除。

## 本地检查

- TypeScript/Vite 生产构建、原生告警/通知包构建通过；仅有既有chunk体积提示。
- `node tests/notifications-runtime.cjs`、真实 IndexedDB persistence、路由和chart-tab回归通过。
- `TZ=Asia/Shanghai node tests/chart-time.cjs` 通过（UTC存储、三个时区、午夜、DST gap/fold、23/25小时边界、毫秒往返和激活图桥接）。完整时区与登录矩阵见[上一轮证据](../chart-timezone-20261019/README.md)，本轮没有重跑该矩阵的每一个人工场景。
- `PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q backend/tests/test_notification_center.py backend/tests/test_chart_alert_notifications.py`：32 passed，1 skipped；跳过项依赖PG环境，PR CI提供PG。
- Ruff针对三处后端改动、JS语法及`git diff --check`通过。
- api/web/chart 均通过 `mw-docker build`，同一 Ubuntu 项目部署成功。最新源码CI以PR #87 checks为准；旧HEAD成功不作为本轮新源码的CI证据。

## 实际运行环境与命令

- 主机：Ubuntu `quant-server`，本机Docker，非SSH转发。
- 项目/task：`mw-issue75-v2-20261018`。
- [验收地址](https://192.168.7.232:18280/advanced-charts/mw75-real?panel=notifications)，沿用已有密码；图表origin `https://192.168.7.232:18281`。
- 15个长期服务均保持running，API/Postgres健康，真实供源和worker继续运行；外部手机投递保持关闭。数据库/volume复用且保留。
- [实际镜像ID与归属标签](images.json)。镜像在本次未提交工作树构建，因此标签为`ed77152 + dirty=true`，实际含本轮源码，不能将旧标签当作干净ed77152镜像。最终提交归档源码与证据，不更改该构建事实。
- 私有Compose文件只在本机使用，不输出或提交；现有wrapper `/tmp/mw75-integrated-compose.py` 指向它。

```bash
# 启动已有全服务实例（保留原volume/数据库）
python3 /tmp/mw75-integrated-compose.py up -d --no-build
# 服务全部启动后刷新网关的容器地址缓存
docker exec mw-issue75-v2-20261018-gateway-1 nginx -s reload
# 停止本项目但保留数据；验收仍进行中，本次未执行停止/退役
python3 /tmp/mw75-integrated-compose.py stop
```

本轮没有合并main、创建正式tag或发布生产。更早暂缓的“系统浮窗不消失”历史现场没有重新归因；当前新时长与显示策略按上面的具体检查报告，不把不同场景混写成历史问题根因修复。
