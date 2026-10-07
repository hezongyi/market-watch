# Issue #13 验收资源归档退役

2026-10-07 23:14 SGT，Ubuntu quant-server本机Docker。用户授权发布PR及验收资源退役；PR [#21](https://github.com/hezongyi/market-watch/pull/21)。10个本任务已结束/被替代的项目全部归档、实际恢复校验并退役，未触及生产。

退役工具已修复固定镜像ID识别，仍校验真实ID和官方PG14 RepoDigest；显式保留共享依赖，拒绝release/rollback/production或不完整归属标签。52项ops测试通过，安装工具与提交源码字节一致。原只验public表已扩为所有业务schema行数及排序后的JSON内容SHA256；备份实际恢复后与来源再次核对。

| project | 容器 | 卷 | 网络 | 恢复数据库 | 校验表 |
| --- | --- | --- | --- | --- | --- |
| mw-issue13-optimized-r2 | 1 | 1 | 1 | 2 | 89 |
| mw-issue13-optimized-r3 | 1 | 1 | 1 | 2 | 0 |
| mw-issue13-optimized-r3b | 1 | 1 | 1 | 2 | 89 |
| mw-issue13-optimized-r3c | 1 | 1 | 1 | 2 | 89 |
| mw-issue13-optimized-r4 | 1 | 1 | 1 | 2 | 89 |
| mw-issue13-optimized-r5 | 5 | 1 | 2 | 2 | 89 |
| mw-issue13-optimized-r6 | 5 | 1 | 2 | 2 | 89 |
| mw-issue13-optimized | 1 | 1 | 1 | 2 | 89 |
| mw-issue13-p0 | 5 | 1 | 2 | 2 | 45 |
| mw-issue13-v114 | 1 | 1 | 1 | 2 | 81 |

合计22容器、10卷、13网络已删除；20数据库、749业务表的行数/内容指纹校验通过。最终Docker label查询显示上述10project无容器/卷/网络。其他17容器的ID、镜像与运行状态均与清理前相同。

共享依赖保留名单及永久自动回收保护记录见 `results/resource-retirement/final-retirement-audit.json` 与各project报告。仅r6独有且无引用网页镜像被回收；不按其他任务镜像名广泛删除、不全局prune。历史失败分母和原始JSON/timeline保留；PG库备份与角色/env在用户私有归档（0700），不提交仓库。各报告仅含私有目录位置、备份SHA及表名/行数/内容指纹。

实际归档位于 `/home/quant/.local/share/market-watch-docker/archives/` 下每个project的独立时间戳目录。通过归档dump可重新在Ubuntu独立project/库恢复，凭据从私有材料读取；原验收Compose已无容器/卷和r6网页镜像，旧启停命令是验收时记录，不能宣称当前地址在线或原服务可直接重启。不要重跑会覆盖已归档证据的验收driver。

终态权威记录：`results/resource-retirement/final-retirement-audit.json`；工具测试/安装哈希：`retirement-tool-verification.json`；每project归档与恢复事实：同目录`mw-issue13-*.json`。原退役预检查拒绝和停止状态保留在r6原验收记录，以本次后续报告更新当前状态。
