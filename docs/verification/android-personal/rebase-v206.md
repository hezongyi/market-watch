# Android 分支变基至 v2.0.6

2026-11-11，按用户“把当前分支调整 base 于 v2.0.6 然后更新 PR”执行。

- 当前分支/路径仍为 `feat/android-personal-v205` / `/home/quant/repos/market-watch-android-personal-v205`，便于延续 PR #131 与任务资源归属。名称中的 v205 是历史名称，当前代码基线已经是 v2.0.6。
- v2.0.6 annotated tag：`8078a6a339f53df3639084389320d6bceff38665`；解引用提交：`d2a3e0925175376746170e2597c6fa675d2fa43d`。本地与 origin 只读查询一致；当次 main 也在该提交。
- 原分支头：`8fc2b01f344dc4fee5d475967e93bbd6a8114bb8`，保留在本任务备份分支 `backup/android-personal-before-v206-20261111`。
- 使用 `git rebase --onto d2a3e0925175376746170e2597c6fa675d2fa43d 1bb935bdf1195c4da532cb2e6f62faca2198e6c4` 重放 9 个任务提交，无冲突。rebase 后头为 `e47c3f6d`（后续仅追加本次验证/CI修正）。
- `git range-diff` 的 9 个提交全部为 `=`；`git merge-base HEAD v2.0.6` 等于准确标签提交。与备份分支相比，只增加 v2.0.6 的 11 个文件、312 additions/3 deletions，没有丢失手机实现。
- v2.0.6 唯一运行逻辑改动为 chart_alert_health 复用 JSON execution_state 表达式，修复 PostgreSQL SELECT/GROUP BY 绑定键不一致；手机使用的接口与字段契约不变。该上游修复完整保留。
- [前端完整构建](build-v206.log) 通过，壳 hash 仍为 `336b1019fb404a53`；[后端小图/健康定向回归](backend-v206.log) 16 passed / 1 skipped，跳过项是需要独立 PostgreSQL fixture 的上游专项，交由 PR CI 的隔离 PG 执行，不能标成本地通过。
- Android CI 初轮失败原因为 setup-android 默认请求已退役的 `tools` 包；改为显式 `packages: platform-tools`，继续安装 SDK35/build-tools35 并 assemble/lint。没有降低检查或改为忽略失败。
- 旧 0.1.1 APK 原生运行代码未变化，历史 APK/source/hash 记录保留；真机、覆盖升级、真实行情和 ntfy 门槛仍待验。

PR 保持 Draft，base ref 为 main（GitHub PR base 需为分支；当次 main 精确位于 v2.0.6）。远端任务分支更新使用明确旧头的 force-with-lease，只重写本任务分支。没有改正式 tag、合并、生产发布或其他工作树。

隔离实例更新与 PR CI 结果随后记录；在更新前，历史候选部署记录不代表新后端已经部署。

后端 CI 的唯一超时已按 [锁竞争诊断](ci-provider-contention.md) 修正测试边界并强化 SQLSTATE 断言；本地真实 PostgreSQL/缓存回归 52 passed，等待最新 CI。
