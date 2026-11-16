# 数据页清除筛选图标

2026-11-14，P0 局部展示调整。`DataManagedPage.tsx` 中筛选提示行和空结果区的“清除筛选”改成已有 shadcn Button `plain/icon` + Lucide X；无底色、无边框，图标18px，透明点击区44×44px。保留可访问名称、键盘焦点和原有筛选重置行为。

完整前端构建、`git diff --check`、Ubuntu真实页面8种布局（375/412px、深浅主题、14/21px字号）通过：正常/悬停背景均透明、边框0、无可见文字、点击区域44×44px，点击清除后恢复完整列表。空结果区也验证同时清除来源与显示范围。无脚本异常或用户配置写入。详见[运行证据](runtime-proof.json)、[日志](runtime-test.log)。截图：[之前](screenshots/before.png)、[之后深色](screenshots/after-dark.png)、[浅色大字号](screenshots/after-light-large.png)。未新建永久测试或重复执行数据全流程。

实际主机为 Ubuntu quant-server 本机 Docker，project `mw-managed-live-rollover-20261113`，地址 <https://192.168.7.232:18447/m/data>。只替换web，API/worker/数据库未变；构建前检查磁盘41GiB、内存约4.8GiB available。使用 `mw-docker build`，task/project归属本任务、purpose为acceptance，显式根context及web/Dockerfile。

web镜像 `sha256:e1bde0af88ba9f5cf45ad3cca0d7afbd520ddf64f85b1e859551675b55118717`，shell `42bcf362f468294e`；运行资源摘要与本次构建一致，APK下载只读挂载保留，无需新APK。私有目录 `/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113` 的 `run.json`/`compose.json` 已留 `*.before-clear-filter-20261114T144841Z` 备份；回退恢复旧web `sha256:156693d60d11af3f506d39233ce86917c295d177c9b5128d8718389a4de2ebe0`，仅本project执行 `up -d --no-build --no-deps web`，不涉及数据库。

启动/停止分别为上述私有目录的 `start.sh` / `stop.sh`。本次未运行远端CI、修改PR、commit或生产部署；Unraid/18443未修改。Android真机触摸仍由用户复核。

后续添加自选保留勾选行为及最新api/web镜像见[本次加入保留验收](../mobile-retain-added-20261114/README.md)。无框叉号继续保留。
