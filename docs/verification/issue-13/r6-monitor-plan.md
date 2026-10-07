# r6：共享monitor周期750ms

2026-10-07 21:39 SGT。按用户已授权的条件方案继续实施，冻结候选bcaefcf位于 `/home/quant/repos/market-watch-issue13-r6-acceptance`，独立分支 `analysis/issue13-alert075`。产品仅 `backend/alerts/alert_monitor.py` 默认周期由1s改为0.75s；生产provider与同价、正常输入、TCP仍调用同一共享入口，保持串行chart+composite watch、逐告警时钟、提交后observer、超期合并和异常退避。不加缓存、不并行evaluate、不用0.5s。

触发证据：r5同价50/50/50完整，保守upper p95 1.001389s、p99 1.027083s；正常310/310/310完整，upper p95 1.018657s、p99 1.134826s。两项p95超过1s，不按四舍五入判通过。正常最大整轮0.454s，无overrun；同价最大chart0.240s。r5读取/容量修复有效，但1秒轮询仍缺足够延迟余量。原结果、完整分母和采样不确定区间保留。

`run_r6_acceptance.py` 等待r5终态及全部本project服务停止后才启动。Ubuntu独立project `mw-issue13-optimized-r6`、网络/卷/DB，PG127.0.0.1:19703；新app19645、chart19646，私有env0600。重建该project所属frontend仅为隔离chart端口，源前端无产品修改；共用既有不可变Python/PG/chart/browser依赖镜像，以实际ID及运行挂载记录证明。r6浏览器尚未启动，地址不是在线交付。

顺序：带归属web构建→真实PG完整后端回归→本库同fixture setup/warmup→所有消费者（90目标/micro/mixed/oracle/330s同价/330s310正常/120sTCP）→真实浏览器→独立原始证据audit与全部数值→进程崩溃/旧应用回退/通知丢失/幂等/组合锁与重试/覆盖白名单重放→最终人工逐项核对。失败保留输出，不自动重置或覆盖。

性能证据适用性：r5四场景三重复300秒是publisher-only，不启动monitor；r6其他174产品及迁移文件与r5逐字节一致，唯一产品差异是未参与这些负载的monitor默认周期。因此保留r5真实source/host/state，不把其重标为r6实测；`inherited-publisher-evidence.json` 明确原SHA、逐文件哈希、差异及范围。r6独立库重新seed并核对初始warmup一致，所有有monitor的消费者及完整API生命周期重新实际运行，CPU/SQL/延迟和输入完整性重新评估。若发现共享路径额外差异或新负载反证，则不能沿用对应旧证据。r5完整发布性能通过不等于r6monitor并发达标。

主工作树仍保持已测r5产品，r6通过最终验收后才整合单项产品改动；未推送、未生产部署。原22:00–22:30收口预估需顺延，取决于r5终态、r6实际构建/回归与消费者结果，不能将待跑检查称已完成。
