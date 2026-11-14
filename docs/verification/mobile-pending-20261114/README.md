# 手机待实现实施与验证

2026-11-14；分支 `feat/managed-live-rollover-20261113`，实施基线 `008586fb`。
用户授权：将待实现实施并验证。范围为 `docs/plans/pending/README.md` 的共享品种搜索和 sparkline 会话方案。
本记录持续补充，当前整体**尚未完成**。

## 共享品种搜索

已实现纯图标直接入口、共享三行品种信息/面板/结果行、三接口查询适配、上滑自动追加、真实身份去重、错误后显式重试、详情/创建返回保留列表和位置。
实际默认组为当前组或第一组，无组时沿用创建规则；重复判断以目标组为准。管理入口集中于左上分组，保留原排序、保存、取消、冲突和未知偏好字段保护。
数据页仍仅列自建，搜索原生目录后进入现有创建流程；维护配置移至既有详情，必要运行状态保留。同名配置在三行之外区分。
没有改变网页端接口、维护/实时开启业务或自选列宽、50px曲线几何及采样。

风险 F0：手机 UI 与兼容查询编排，无数据库格式变更。最终需本分支 Ubuntu R1；不涉及生产。

本地验证（生产构建 + 独立 HTTP fixtures，不代表供应商或 Android 系统行为）：

- `npm run build` 通过；TypeScript/Vite/native hooks/mobile shell 完整构建。
- `node tests/mobile-symbol-search.browser.cjs` 通过：自动追加、同代码不同身份、去重、末页、快速改词、失败不循环重试、分组判断、连续添加、详情/创建返回位置恢复；375/412、深浅主题、150% 字号。
- `node tests/mobile-watch.browser.cjs` 通过：控件全量、分组/排序/冲突、抽屉跟手/退场/脏表单/减少动效、连接/后台生命周期、过期搜索响应及详情选组。
- `node tests/mobile-data.browser.cjs` 通过：共享搜索及详情、自建 MWH/MWC 真实身份、禁用/未就绪、缓存/离线/恢复。
- `MOBILE_DATA_OUTPUT=/tmp/mw-pending-final-workflow node tests/mobile-data-workflow.browser.cjs` 通过，14组检查、55张截图：创建、维护、接续、冲突/响应丢失、返回确认、深浅主题/字体矩阵。
- `MOBILE_VISUAL_SCOPE=identity MOBILE_VISUAL_OUTPUT=/tmp/mw-pending-final-identity node tests/mobile-watch-a07.browser.cjs` 通过8种自选布局；复用信息后字号、列宽、行高、价格及曲线几何保持。
- `git diff --check` 通过。

截图：基线 `/tmp/mw-pending-20261114-before`；共享搜索 `/tmp/mw-symbol-search-20261114`；自选控件 `/tmp/mw-watch-controls-regression`；数据详情 `/tmp/mw-data-final`；数据流程和自选几何见上述唯一目录。已实际打开截图检查，原生来源11px、自建来源10px及代码15px延续已认可的层级。
实际 Android 输入法/系统返回/真机触摸仍待设备复核；浏览器模拟返回不作为真机通过。

## sparkline 会话

尚未改代码。基线 `PYTHONPATH=backend pytest -q backend/tests/test_sparklines.py backend/tests/test_sparkline_sessions.py backend/tests/test_sparkline_backfill.py`：27 passed。
需继续实施统一跨日选择、当日收盘状态、真实参考价及缓存/prepare边界，再完成同批 Ubuntu 验收。

## Ubuntu 与发布

已有本任务 project `mw-managed-live-rollover-20261113` /18447；当前仍为此前镜像，**尚未部署本次改动**。
磁盘约48GiB可用，内存约4.5GiB可用；已有其他project，不停止它们。只更新本任务服务，使用受管 `mw-docker` 构建。
没有 Unraid、合并或正式 tag 操作。
