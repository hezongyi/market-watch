# 前日高低突破快捷模板

基线：main `f4a3279a`（v2.0.16）。分类 F1：新增只读预填接口及菜单/表单交接；无需 schema 迁移。模板配置可选加入 close_expiry_grace_ms=120000，用于收盘截止结算，新后台支持此配置；旧规则默认 0，序列化和 request hash 保持原样。涉及重要后台边界，执行独立 Standards/Spec review。

确认范围：十字线加号和主价格菜单增加“前日高低突破…”。同源上一交易日 D1 高低点固定填入**一条**现有 exit 价格区间规则；默认 M5 / close / max_triggers=1 / 当日结束截止。现有九种条件与普通固定价格快捷创建保持原样。不增加每日轮换、每方向额度或第二次突破策略。

参考数据：按当前组合修订与日界读取已物化日线。只跳过有供源日历证据的休市日；最近应有交易日数据缺失不退回更早日线。允许常见稀疏 M1；确认与已完成查询证据独立核验，不以分钟数量齐全为门槛。页面预填参考日期、当地截止时间；最近已确认 M5 在区间外时提示需回区间后再离开。

到期：系统原有 expires_at 为排他上界。模板写入 D1.end+1ms，包含恰好在 D1.end 收盘的最后一根 M5，下一根收盘 D1.end+5min 被排除。模板到期后最多等待 120 秒，截止区间确认就绪才冻结最终输入；超时保留无法确认的记录。cursor_limit 始终固定于 D1.end，不接纳下一交易日 K 线。旧规则无此等待，保持原到期语义和结算快照。手机表单保留未编辑截止值的毫秒精度，用户显式改时间继续按其输入保存。

验证：后端 preset/settlement/close/notification/API/service 回归 87 passed、1 skipped；另新增 UTC0 日期边界后 preset 17 passed。桥接单测 15 passed。TypeScript/Vite/原生图表完整构建通过；实际许可 widget 的桌面快捷流程和新模板浏览器流程通过。手机模板流程通过，覆盖 375/412px、深浅主题、100%/150% 字号，截图已人工检查。验证了单次提交、截止毫秒保留、区间外提醒、图表仍保持原 H1、无桌面布局/偏好写入。数据写入及触发仅使用测试夹具。

独立 Standards/Spec 审查发现最终确认仍使用原 started_at 的问题；现统一使用 frozen_at（旧规则 fallback started_at）围栏确认与读取完成时刻，并补充截止前已观察、截止后 30 秒确认的真实 LiveMinute 时序回归。Standards 与 Spec 复审均通过，无剩余阻断。另补充最后 M5 两方向事件消息包含上破/下破标识的回归，3 passed。

兼容与回退：无 schema 迁移；旧规则的默认序列化与请求 hash 不变，新代码可读既有配置。新模板会持久化 close_expiry_grace_ms=120000，旧后台 extra=forbid 无法识别，因此创建模板后不能仅换旧镜像降级。回退须先导出受影响规则及版本，再定向移除新增字段（会失去最后 M5 等待语义），或使用相应备份；不默认恢复整个数据库覆盖用户后续数据。本次开发实例验收只读，不创建真实规则、不发送 ntfy，部署前后保留规则快照；若无新模板规则，旧镜像可直接回退。

开发实例于 2026-11-20 12:19 UTC 部署完成，实际主机为 Ubuntu 本机 Docker，project `mw-dev`。访问 https://quant.kookvv.com:8443/m/chart ，保留 HTTPS 18443 直连及现有下载挂载。本轮仅更新 Web/API 和三个 Python worker 的镜像；PostgreSQL、TLS、ntfy 容器 ID 不变，无 schema 操作。服务器页面更新即可使用，无需安装新 APK。

真实认证 API：9/9 自建品种预填成功，耗时 68–127ms。AUDJPY、AUDUSD、NZDUSD、GBPJPY、USDCAD、EURUSD、USDJPY、XAUUSD、GBPUSD 的参考交易日均为 2026-11-19，NY17 当前截止为 2026-11-20 22:00 UTC。分别读取同修订的前日 M1（1380–1440 根，包含正常稀疏行情），独立重算 min(low)/max(high)，9/9 与预填一致。例：EURUSD 1.095540–1.100990；XAUUSD 3619.788000–3758.424000。

实际部署页面：XAUUSD、EURUSD 从真实图表十字线加号打开预填表单，核对日期、上下沿、区间外提醒并截图检查，随后关闭，未提交。未发出告警创建/编辑/生命周期及桌面布局/偏好写请求。部署前后 7 条真实规则的状态、次数、run、version 和 12 个历史版本配置均一致。真实 PostgreSQL 既有版本均可被新 AlertConfig 解析。API ready、认证告警列表、行情状态通过；market/data/notification 共 39 个角色采样无 error_type。APK 更新清单 200、真实 JSON、Cache-Control:no-store。

实现镜像基于 commit `a965e6d7`；之后仅追加测试断言与验收记录，不改变运行代码。

- API / market-runtime / data-worker / notification-worker：`sha256:e1b48c618fa5437d83bb9b2b975407c7da4494b9ddaf02c8bfa865ac90c169cc`
- Web：`sha256:a4fd9a432e5bdee12f3332838df914afdc361ec5e9a989e694912606bcf1a432`
- 部署前 API：`sha256:5403a1602e5e2f4a09294dd6988fc71d077465983029b0b713053866aba91d31`
- 部署前 Web：`sha256:32781c2eaab3ca9beda9c85363f460fd3d24beaf73c3cac7b72b62d2966bc1ed`
- 部署前 notification-worker：`sha256:2859c77d79d491911adf59309760de5841c006d594e0b1d021455ec8f4dacaa2`

持久配置已同步到 `~/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json`。只启动本轮服务：

```bash
docker compose -p mw-dev -f ~/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json up -d --no-build --no-deps api market-runtime data-worker notification-worker web
mw-dev status
# 仅在需要停止开发实例应用服务时执行：
mw-dev stop api market-runtime data-worker notification-worker web
```

旧镜像及配置快照保留于私有 `~/.local/share/market-watch-dev/evidence/previous-day-alert-20261120/`，含 run-before.json、部署前后规则快照、candidate-images.json、真实 API 与 M1 对照、浏览器检查。回退前先核对是否已有真实模板规则，再按前述配置兼容边界处理；仅替换涉及服务的旧镜像引用，不覆盖其他配置，不默认恢复数据库。本次未运行回退或删除资源。

浏览器截图：[浅色 412px](mobile-light-412.png)、[深色 375px / 150% 字号](mobile-dark-375-150.png)。Android 系统键盘、真机触控和实际通知实收未在本轮验证；浏览器普通快捷告警的触控拖动回归通过。本轮没有真实告警或 ntfy 测试，通知出站行为仅通过夹具验证。唯一跳过项为要求隔离 PostgreSQL 的既有通知精度测试，由 PR CI 的 PostgreSQL 服务执行。

## 图表上的双边界显示

本轮增量为 F0：复用已有 `exit` 价格区间规则和原生 order-line 展示，不新增后台条件或持久字段。两条同色虚线、价格轴标价和前高/前低文字，共用一个“前日高低 · M5”标签，不填充区间、不自动撑大价格轴、不允许拖动改参考价格。普通区间离开规则使用“区间告警 / 上沿 / 下沿”，避免误标为前日高低。

点击标签或任一边界管理同一条规则，支持暂停/恢复、编辑和结束；手机复用原编辑抽屉，桌面进入原生规则详情。暂停后两条线和标签一起变灰；完成、到期或归档后一起清除。跨图表周期仍保留规则自身的 M5 标识；换品种按完整行情身份隔离。标签及原生订单展示不进入绘图、撤销栈或布局存档。

验证：桥接单测 6 passed，原生几何/生命周期浏览器契约通过；特别覆盖生命周期写响应丢失后，后台轮询先取得新修订，用户仍能核验成功且不重复写。桌面真实许可 widget 覆盖双边界、下沿打开同一规则、暂停恢复、M5→H1、深浅主题、编辑及到期清理。手机完整模板→提交→双边界→打开原规则通过，含 375/412px、深浅主题及表单 150% 字号。独立桌面/手机 widget 的布局、偏好和指标隔离回归通过，未写桌面布局/偏好。完整 Web 构建通过；默认配置序列化断言与旧版本 hash 夹具均已按旧字段集合修正：兼容配置回归 13 passed，ATR/旧请求重放及 service 回归 77 passed。截图经人工检查：[手机浅色](range-light-375.png)、[手机深色](range-dark-412.png)、[桌面双边界](range-desktop.png)。这些交互写入仅使用夹具，非真实规则或 ntfy 投递。

2026-11-20 13:41 UTC 已部署 Ubuntu 本机 `mw-dev`，仅替换 Web 为 `sha256:46b935cf0f4f8d989e3a9812870adab93615c71bcab2b881028a50c5abcc4f9b`；API、各 worker、PostgreSQL、TLS、ntfy 容器保持。持久 launcher 的 run.json 已同步。旧 Web 为 `sha256:a4fd9a432e5bdee12f3332838df914afdc361ec5e9a989e694912606bcf1a432`，本轮展示层可仅将 Web image 改回并执行上述 compose 命令（只指定 web），无需数据库回退。配置快照为同一私有 evidence 目录的 `range-run-before.json`，不整份覆盖其他配置。

访问地址和操作入口沿用上文；无需新 APK。部署后实际 XAUUSD/EURUSD 页面打开预填并关闭，无告警或布局写请求；新部署原生图表脚本与已验收构建逐字节一致。`/m/chart`、认证告警列表、ready 与 APK 更新清单均通过；真实规则、版本及自建修订的部署前后快照一致。详细报告及完整截图位于私有 evidence 下 `range-deployment-checks.json`、`desktop-range-final/`、`mobile-range-final/`、`range-isolation/`。Android 真机触控仍需用户验收。

现有真实 EURUSD 前日高低规则的部署页面也已只读核验：1 条规则对应 1 个“前日高低 · M5”标签和 2 个边界，H1 图表保留 M5 规则标识。人工检查实际截图，未发出告警或桌面布局写请求；私有证据为 `live-range-result.json` 与 `live-EURUSD-range.png`。
