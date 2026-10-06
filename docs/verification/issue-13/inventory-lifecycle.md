# 台账生命周期与证据限制

初次清点（UTC22:25，Ubuntu）：66个容器，涉及三层、旧接入、两个告警、两个范围同步、MCP及本任务。初次台账在UTC23:45刷新时被同名inventory.json/md覆盖；初次完整inspect字段未另行归档，不能称其完整原始记录仍存在。

早期带时间戳资源观测保留于 [suite-host.jsonl](results/suite-host.jsonl) 和 [API线程采样](api-observation.json)，可证明采样期间的容器名称、CPU/内存/网络I/O/块I/O等，不能恢复已消失容器的全部挂载、镜像revision、compose路径或配额。最初清点的详细字段不可由后续已停止/删除实例推断。

最新UTC23:45台账：[inventory.md](inventory.md)、[inventory.json](inventory.json)，17个容器、14个running；仅剩旧接入、三层和本任务已停止PG。本任务没有停止、删除或修改其他项目；数量变化是观察到的外部状态，不能将其记为本任务清理成绩或假称已确认其他任务结束。

inventory.py后续刷新在读取当前状态前按旧文件mtime归档已有json/md，避免再次覆盖唯一证据；归档仍不证明任务是否闲置。任何清理须按完整Compose来源、资源归属和任务完成状态确认。状态文件、名称与运行时长不足以证明允许停止。

本任务suite和消费者完成后显式停止自身PG，核验 `exited / exit0 / running=false`，保留 `mw-issue13-p0_pgdata`；没有全局prune、跨任务清理或生产改动。
