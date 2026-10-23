# v1.27.0 集成源码发布

PR [#93](https://github.com/hezongyi/market-watch/pull/93) 已合并到 main，提交为 `ffc814977086dd01b10240333c92079fb89ec53c`。用户于 2026-10-23 授权推送候选和正式 Git tag。兼容新增功能采用次版本 `1.27.0`，正式标签目标为本次版本整理通过 CI 后的 main 提交；以 `git rev-parse 'v1.27.0^{commit}'` 解析实际目标，所有历史标签保持不可移动。

`v1.27.0-rc.4` 固定在 `ffc8149`，包含 rc.3 后的 Ruff 和测试夹具修复。正式版额外同步 Python/web、npm 锁文件根版本、CHANGELOG 和源码交付资料；运行代码、测试、依赖及迁移与 rc.4 保持逐字节一致。

## 验证与风险

功能集成属于 **F1**：包含 additive `ax51_mapping_notes` 及后台链路变更。版本整理自身属于 **P0**，只涉及版本和资料；最小检查为版本一致性、依赖和运行源码等价核对、diff 检查、自审及发布 PR CI。

- 完整 PR CI：[39922933737](https://github.com/hezongyi/market-watch/actions/runs/39922933737)，受测 head `cef01979d0d52f4cc3019406765dce17df4649e1`，Python 2830 passed / 18 skipped。显式 PostgreSQL mapping 1 passed、observed-policy 8 passed，与全量套件有重叠，不相加。
- main CI：[39928555061](https://github.com/hezongyi/market-watch/actions/runs/39928555061)，目标 `ffc8149`，全部成功；合并树与受测 PR head 一致。
- 最终独立 Standards / Spec review 均无剩余发现：[PR review](https://github.com/hezongyi/market-watch/pull/93#pullrequestreview-5625846978)。
- [映射与迁移验收](verification/mwa-integration-review-20261022/closeout.md)、[Python 指标](verification/python-indicators-20261022/README.md)、[通知可靠性](verification/notice-reliability-20261022/README.md)、[切换调度收口](verification/watchlist-switch-latency-20261022/CLOSEOUT-20261023.md)保留原始结果和失败记录。

旧应用读取新映射已验证；这不代表旧镜像写入兼容性。观察覆盖 17 个分钟边界，未完成 30 分钟观察；既有平台或指标秒级等待仍保留，不宣称长期零回归或稳定 p95。旧 VM/指标脚本失败不改写为通过。

## 镜像与回退边界

本次只发布源码，不构建、改标或传输镜像，不执行生产迁移或切换。已有 mwa 验收实例和混合来源镜像仍保持各自构建身份，不视为正式 tag 构建。源码清单见 [v1.27.0-source.json](../deploy/releases/v1.27.0-source.json)。

应用回退可保留 additive 映射备注表，旧映射、组合身份和数据不删除。生产部署须另行核对实际运行基线、迁移路径、备份恢复及固定镜像；Git tag 授权不包含生产部署或永久数据删除。
