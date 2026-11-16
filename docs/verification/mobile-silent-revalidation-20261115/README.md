# 手机端缓存回显静默刷新

2026-11-15，当前 `feat/managed-live-rollover-20261113` 工作树。P0：局部提示展示调整，缓存、请求、行情和写入锁不变，保留此前未提交工作。

## 原因与范围

数据主页读取本地快照时设置 `readAt`，联网查询成功后清除此字段；原页面按该字段插入“上次读取…当前状态待核实”，因此导航后会先出现一行文字再消失，列表随之移动。检查手机端所有“上次/更新/读取/缓存”相关展示后，本次修正：

- 数据主页、自建详情：正常联网刷新不显示快照提示；离线仅显示“当前离线”，失败保留就地错误。自建详情原实时摘要行不因正常快照刷新追加“上次状态，待核实”。
- 自选：去掉正常缓存恢复时“正在确认 · 当前显示上次自选”；离线/失败提示照常保留。
- 行情详情：正常刷新不插入“上次读取的详情”提示框；已有数据状态行短暂显示“核验中”，不增加布局行。离线与失败时保留快照说明。
- 事件记录的异常/恢复、系统页：去掉联网读取期间临时出现的上次读取时间；离线保留简短说明。
- 专业图表预览：保留上次截图立即回显，正常更新不覆盖“上次数据…更新中”文字；更新失败仍显示失败状态。图表的可访问名称仍标明上次图表。
- 添加自选/添加自建已无同类快照提示，告警列表也没有；更多页的最近核验时间、任务实际更新时间、行情数据本身的历史/缓存语义属于持久业务信息，保留。首次无内容加载、主动下拉刷新、错误、离线和禁止未核验写入均保留。

## 验证

- `cd web && npm run build`：通过，见 [构建](build.log)。
- `MOBILE_DATA_CATEGORIES=1 MOBILE_DATA_OUTPUT=../docs/verification/mobile-silent-revalidation-20261115/categories node tests/mobile-data-workflow.browser.cjs`：通过。新增人为挂起网络查询、直接展示已保存的 56 条缓存、MutationObserver 检查提示插入及首行坐标前后相等；分类/分页/导航位置、下拉刷新、错误重试、断网和 375/412px/深浅主题/150% 字号回归均通过。见 [输出](categories.log)、[缓存读取中](categories/cached-revalidation-pending.png)、[更新后](categories/cached-revalidation-finished.png)。
- `MOBILE_DATA_OUTPUT=../docs/verification/mobile-silent-revalidation-20261115/details node tests/mobile-data.browser.cjs`：通过。新增有缓存时挂起详情查询，验证不插入快照提示框；失败时快照说明仍可见，重试和离线流程正常。见 [输出](details.log)。
- `MOBILE_CHART_CONTINUITY_ONLY=1 MOBILE_CHART_OUTPUT=../docs/verification/mobile-silent-revalidation-20261115/chart node tests/mobile-chart.browser.cjs`：通过，使用本机原生图表许可资源，验证重载/切周期慢查询期间仍立即显示已有截图、无覆盖文字，数据返回后退出截图；无页面异常。见 [输出](chart.log)。
- `node tests/mobile-watch.browser.cjs`：通过，自选控件、分组、缓存滚动位置、导航保持 SSE、后台暂停/前台重连与行情刷新回归无异常，见 [自选回归](watch.log)。
- [真实环境脚本](runtime-check.cjs) 与 [结果](runtime-proof.json)：Ubuntu 本机真实目录只读验收，通过挂起 GET 请求观察数据列表、自建详情、自选、异常/恢复记录、系统记录。数据列表首行 Y 为 127→127，MutationObserver 未发现临时快照提示；离线保留说明且实时开关禁用。7 张截图已查看，无页面异常、无意外写入。后台 quote/sparkline/resolve/subscribe POST 在浏览器拦截，作为 blockedBackgroundReads 单独记录，未发送到服务，不据此验证行情连接/实时数据。见 [最终输出](runtime-final.log)。
- [部署检查](checks.json)：APK CA 可信 HTTPS、6 项手机资源、shell/SW 版本、`/readyz`、image 一致，APK 下载只读挂载、清单 no-store、APK 大小/SHA-256 与不存在地址 404 通过。
- `git diff --check` 通过。浏览器验收不能代替 Android 真机手势与生命周期体验。

真实脚本最初从导航得到的 `/m` 直接 reload，触发验收网关去端口的重定向并报连接拒绝；改用已存在的明确 `/m/watch` 页面地址重新加载后完成缓存检查。此问题与缓存提示无关，本次未修改网关，早期输出保留在 runtime.log/runtime-retry.log。

## 部署

已更新 **Ubuntu 本机 Docker** 当前验收实例，仅替换 web：

**https://192.168.7.232:18447/m/data**

无需新 APK，通过“更多 → 检查更新”应用网页更新。版本与 image 见 [部署记录](deployment.json)，构建使用带明确根 context 的 `mw-docker build`，见 [构建日志](docker-build.log)。未更新 PR、远程 CI、commit、正式 tag 或 Unraid。

```bash
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

私有 run.json/compose.json 已备份为 `.before-mobile-silent-revalidation-<stamp>`。回退仅改二者 web image 为部署记录中的 previous image，再对当前 project 执行：

```bash
docker compose -p mw-managed-live-rollover-20261113 \
 -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json \
 up -d --no-build --no-deps web
```
