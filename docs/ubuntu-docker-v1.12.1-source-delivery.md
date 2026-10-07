# Ubuntu Docker 维护 v1.12.1 源码交付

2026-10-07。PR [#15](https://github.com/hezongyi/market-watch/pull/15) 已在 `ec9403a` 合入main；受测工具提交 `ad5bba1`。本次同步Python/web、锁文件根包及CHANGELOG为1.12.1，不改变受测工具、业务逻辑、schema或依赖。

用户授权创建并推送tag。附注标签 `v1.12.1` 指向发布元数据PR最终main合并提交；用 `git rev-parse 'v1.12.1^{commit}'` 解析。源码边界及受测工具SHA256见[发布清单](../deploy/releases/v1.12.1-source.json)，旧版本标签保留。

Ubuntu `quant-server` 已安装Buildx和专用 `market-watch-ubuntu` BuildKit，配置8 GiB缓存回收目标及20 GiB空闲目标；通过 `mw-docker` 记录任务归属并按生命周期清理。缓存回收目标不是硬配额；用户级入口可被绝对路径/API绕过，必须遵守AGENTS中的构建约定。

工具25项测试通过，实际BuildKit/Compose、本机基础镜像OCI输入、123行PG fixture备份和恢复、项目精确退役及过期任务自动清理通过；3个user timer启用。记录和本机启动/停止命令见[验收记录](verification/ubuntu-docker-lifecycle/acceptance-20261007.md)和[维护说明](../deploy/ubuntu/README.md)。没有把历史候选镜像改标为v1.12.1，已安装工具的来源仍为原受测提交。

源码发布不切换Unraid生产、不执行生产迁移。回退源码参考v1.12.0；需停用本机运维工具时按维护说明停止其timer及专用builder，保留数据和其他项目。
