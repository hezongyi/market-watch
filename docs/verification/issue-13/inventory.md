# Ubuntu 实例台账

采样：2026-10-06T23:45:43.577808+00:00；主机：quant-server / Ubuntu 22.04.5 LTS。

只记录配置来源和资源，不包含环境变量、启动命令或凭据。标签能证明来源，不能证明任务已完成；所有其他项目保留。

| Compose project | 配置来源 | 容器数 / running | 短时 CPU 总和（均值） | 内存总和（最后一次） |
| --- | --- | --- | --- | --- |
| market-watch-data-integration | /home/quant/repos/market-watch-data-integration/docs/verification/data-integration | 7 / 6 | 96.0% | 142.5MiB + 265.5MiB + 103.8MiB + 179.5MiB + 4.727MiB + 637MiB |
| market-watch-three-layer | /home/quant/repos/market-watch-data-integration/docs/verification/three-layer | 9 / 8 | 6.1% | 92.17MiB + 100.9MiB + 102.8MiB + 5.027MiB + 117.7MiB + 161.3MiB + 5.406MiB + 183.9MiB |
| mw-issue13-p0 | /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13 | 1 / 0 | 0.0% |  |

Docker CPU 100% 为一个逻辑核。原始三次短采样、精确配置路径、镜像 ID/revision、端口、挂载、网络和配额见 [inventory.json](inventory.json)。

未查询其他任务业务数据库或秘密配置，因此无法证明其数据库名、活跃订阅/策略数、任务是否完成。未知归属或闲置状态未核实的资源不能停止。
按台账配置路径确认任务完成后，停止命令模板为 `sg docker -c 'docker compose -p <project> -f <config-file> stop'`；涉及多份配置必须显式指定全部文件。当前没有执行该操作。
