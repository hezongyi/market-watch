# 数据页搜索筛选工具

2026-11-15，`feat/managed-live-rollover-20261113` 当前工作树，P0 手机端局部 UI/搜索接入，保留此前未提交修改。沿用已有移动端自建列表搜索接口，无后端、存储或告警逻辑修改。

## 变化

- 数据页“筛选与工具”改为与告警规则筛选相同的纵向表单：搜索自建行情 → 来源 → 显示范围 → 查看行情；“任务与来源”仍作为底部独立导航行，按原抽屉退场后交接。
- 使用现有 DataInput、DataSelect、FieldGroup、Button、Drawer 和数据表单样式。代码、中文名、来源、类别及空格组合词使用已有服务端移动搜索，在过滤后分页。回车与“查看行情”均能提交；关闭抽屉沿用筛选生效语义。
- 编辑条件期间暂停列表请求，避免逐字请求或组合筛选的中间请求；抽屉关闭后统一读取。分类、分页、缓存和下拉刷新沿用原逻辑。
- 搜索词纳入右上角筛选标记、已选条件、清除操作和会话滚动位置键。一次清除搜索与来源/状态，保留当前分类；空结果仍能直接清除，不去更改添加原生行情的搜索入口。

## 验证

- `cd web && npm run build` 通过。
- `MOBILE_DATA_CATEGORIES=1 MOBILE_DATA_OUTPUT=../docs/verification/mobile-data-search-tools-20261115/categories node tests/mobile-data-workflow.browser.cjs` 通过，28 张截图：原分类、分页、缓存、真实触摸刷新、断网与请求取消；新增搜索首屏外条目、编辑期间不请求、提交、回车、空结果、标记、清除及保留分类验证。
- `MOBILE_DATA_OUTPUT=../docs/verification/mobile-data-search-tools-20261115/workflow node tests/mobile-data-workflow.browser.cjs` 通过，56 张截图，覆盖创建/维护/实时/归档/工具/详情流程及手机返回、错误与冲突、深浅主题和大字号。
- 已查看 375px 常规和大字号搜索工具截图。专项覆盖 375/412px × 深浅主题 × 14/21px 字号；真实环境验证补充缩短视口后聚焦搜索与提交可达，不能等同 Android 真实键盘验收。
- 部署后真实 API 只读核对代码、中文名、实际供应商、代码+供应商前缀、类别搜索；编辑条件不发送列表读取；筛选清除、任务与来源交接和 8 组合截图见 [运行记录](runtime-proof.json)。供应商样本取自实例实际自建记录，不假定每个源都有已建行情。真实用户行情与通知无写入，认证会话从私有凭据创建。
- HTTPS 使用 APK 信任的 CA 核对，shell/SW/manifest 版本一致，6 个资源与 readyz 均 200，运行镜像一致、APK 下载目录原只读挂载保留，见 [检查记录](checks.json)。`git diff --check` 通过。

## 部署与使用

实际主机为 Ubuntu 本机 Docker，project/task `mw-managed-live-rollover-20261113`；访问 **https://192.168.7.232:18447/m/data**。仅替换 web，镜像及前镜像见 [部署记录](deployment.json)。无需新 APK，通过“更多 → 检查更新”应用网页更新。

启动/停止：

```bash
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

私有 run.json、compose.json 均已留存 `.before-mobile-data-search-tools-<stamp>` 备份。回退时只改回部署记录中的 web previous image，再对同 project 执行 `up -d --no-build --no-deps web`；不整体覆盖其他服务或数据库。未更新 PR、运行远程 CI、打正式 tag 或操作 Unraid。
