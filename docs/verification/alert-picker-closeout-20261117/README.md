# 告警选品遗漏收口 · 2026-11-17

## 基线和改动

独立分支 `fix/alert-picker-closeout-20261117`，基于 main `86692cee`。迁入旧 `ba499417` 工作区未提交的后端三文件、对应测试、告警浏览器回归与开发下载挂载。原手机选品前端已由 #141 保存，本次不重复修改。原后端文件与新工作区逐字节一致。

F0：兼容的只读列表筛选和开发下载目录挂载，无 schema 或告警执行/投递策略变化。保留原维护、实时和规则能力校验。原部署记录保存在 `../mobile-alert-picker-20261116/README.md`，其中实例数量只是当时采样。

## 复现与本地验证

在 main 仅迁入测试运行：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q backend/tests/test_dataset_summaries.py -k alert_picker_filters_before_paging
```

旧代码失败：`TypeError: _dataset_query() got an unexpected keyword argument 'alert_eligible'`。迁入实现后：

- dataset summaries / live API / rolling-range-squeeze：43 passed。覆盖采集开启但未保存自建实时开关、无映射、开关启停、分页前过滤、末页与搜索，以及默认列表兼容。
- 变更 Python 文件 Ruff、`git diff --check`：通过。
- Compose 测试：9 passed、50 subtests passed，包含开发 Compose 渲染。
- `cd web && npm run build`：TypeScript、Vite、许可专业图表及手机 shell 完整构建通过。
- `cd web && MOBILE_ALERT_OUTPUT=<私有证据目录>/browser node tests/mobile-alerts.browser.cjs`：全流程通过；未开启实时的品种不再出现在选品列表，页面错误为空；含375/412px深浅主题和大字号。

## Ubuntu 开发实例核验

实际主机 Ubuntu Docker，既有持久实例 `mw-dev`，`https://192.168.7.232:18443`。本轮不重建、不重启服务：已部署 API 三个文件与候选代码 SHA256/内容逐字节一致，无需为了补提交重新部署相同实现。

严格使用当前 TLS 入口的手机 CA，正常认证后只读请求：普通列表14条；告警候选4条，与普通列表中已保存自建实时开关及映射的集合完全一致。每页1条遍历及末页、搜索均通过。没有创建/修改业务规则，没有发送通知；登录只建立验证会话。

`/readyz`、`/m/`、`/downloads/android-update.json` 均200，更新清单保留 `Cache-Control: no-store`。当前下载目录已按相同目标只读挂载；本次将其补入仓库 Compose。未重新验证APK签名或Android安装，不宣称真机通知实收。

## 开发入口与旧工作区退役

`~/.local/bin/mw-dev` 从旧临时工作树迁到固定 `/home/quant/repos/market-watch`；主工作区从干净旧 main 快进至已合并 main `86692cee`。两个工作区的 `deploy/ubuntu/mw_dev.py` 字节完全相同，launcher 只替换 repo 路径，实际运行 `run.json` 未改动。`mw-dev status` 通过。启动/停止入口保持 `mw-dev up` / `mw-dev stop <服务>`，不在本轮执行重启。

私有证据、旧 launcher、完整 binary diff、旧 HEAD 恢复引用及本地资料归档放在 `~/.local/state/market-watch-cleanup/20261117-alert-ui-closeout/`，不提交私有 APK 解包内容、许可库、凭据或完整状态到 Git。恢复旧树：`git worktree add --detach NEW_DIR refs/cleanup/20261117-alert-ui-closeout/original`，然后应用 `original.patch` 并按归档 receipt 解压本地资料。

本次仅提交补丁 PR；不合并、不打正式 tag、不操作 Unraid。开发实例验收无需重新安装 APK。
