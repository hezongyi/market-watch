# 独立审查记录

固定基线 `ef57bed61f66715a4c5ec2797f9abd67cb23d2fb`；首轮审查终点 `44a79a76`。审查者分别为只读 Standards、Spec agent；后续复核当前修复 diff，不操作服务或修改文件。

## Standards

- P2：验收 PG healthcheck 缺 JIT provider 探测。已复用仓库根配置 `PGOPTIONS='-c jit=on'` + `pg_jit_available()`，复核确认关闭。
- P3，非阻断建议：手机配置 reason 判定重复。保留现有角色边界，未为建议扩大重构。
- 增量复核：未见新增硬性规范偏差。
- 审查者另提示运行时故障脚本的 evaluator 实际归属为 market-runtime，脚本已更正为该角色：存活场景在真实 step 边界暂停推进，进程场景停止任务 market-runtime，notifications 独立运行。

## Spec

首轮三项发现均已复现，新增最小5用例在修复前全红：

1. P1：关闭实时采集后到期丢弃已提交有效积压。已允许限定结算读取已取得输入，不重新打开采集，intrabar / close 回归通过。
2. P2：edit / restart 清空故障实例引用，通知永不关闭。已保留历史并等待实际恢复；编辑离开价格路径发 `observation_end`，不伪造恢复。
3. P2：进入休市无条件标为恢复。closed 默认不关闭故障；触价须有实际有效输入且无需恢复基准才解除。状态相同的 closed→有效closed 也可处理恢复。

后续补充复核曾发现：相同状态快速返回忽略 resolve_incident；编辑为复杂规则遗留隐藏故障。这两项已分别加入公开 evaluate / edit→通知投影回归。最终只读复核结论：**两点已闭合，未发现新的实质遗漏**。

修复后的 execution / settlement / close 共67项通过；真实PG追加边界15项通过。审查通过不代替性能、完整CI或最终浏览器验收。

## 取锁时间竞态增量复核

真实浏览器偶发返回 `price_baseline_unavailable`。真实 PG 并发测试确认：请求记录时间后等待 dataset 锁，collector 在等待期间提交新报价，旧时间将该报价误判为未来，原实现在 create 场景稳定失败。

修复为价格准入取得 dataset 锁后刷新真实时钟，create/edit/resume/restart 在锁内确定生效时间并重新检查到期；显式 `at` 保持固定时间语义。原锁持续覆盖基准、日志位置、需求与规则提交。两位原独立审查者再次只读复核该增量，均未发现新的实质问题；实际测试结果见 README。

## 完整 CI 回归修复复核

Standards 增量复核无阻断项，确认旧组件保护、公开价格路径及真实 PG 包装保留，历史迁移固定原目标并由独立 price-v2 迁移契约覆盖。其建议保留旧规则重查后当下无持久信号断言，已补回。

Spec 要求补强两处断言：在原生 D1 证明已缓存后创建公开规则，仍无基准；并发信号同时验证发生/发现时间及监控状态。两项均已补强，原审查者只读复核确认关闭。M5 射线使用实际周期标签，避免错误端点导致测试未进入待验证路径。最终测试与 CI 结果见 README / PR checks。
