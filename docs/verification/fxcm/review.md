# FXCM F1 独立审查记录

审查范围：相对 `59ed3a3f3fc727da76d13149934d999ebee04218` 的 FXCM 实现、测试、部署和验证材料。两项审查均未读取凭据、未修改代码、未启动或修改任何验收实例。

## Standards

初审发现一项 P1：异常、取消或超时时，`fxcm_history.py` 会在原生 helper 完全关闭前释放共享 FXCM source slot。这可能让下一请求与正在清理的 helper 重叠，违反全来源并发为 1 的约束。

修复将异常路径的 `close()` 放在 `request_slot` 内，只有子进程清理完成后才释放 slot。另将 FXCM token 的节流时间记录为请求完成时刻，避免冷登录耗时后其他进程按过早的准入时刻继续请求。

独立复核实际运行：

```text
test_fxcm_cancellation_keeps_shared_slot_until_child_closed
test_fxcm_long_login_paces_other_process_from_completion
2 passed
```

最终结论：该 P1 已关闭，无未关闭 Standards 发现。

## Spec

初审发现嵌入数据中心中的显式 FXCM 目录刷新仍使用普通管理请求的 30 秒超时，低于 native helper 的 65 秒预算。

修复在 `advanced-host/bridge.js` 为 `POST /market-data/history-catalog/refresh` 且 `body.source === "fxcm"` 使用 70 秒超时。普通管理请求仍为 30 秒，FXCM 原生历史仍为 610 秒，reserve 为 70 秒。

独立复核实际运行 `node web/tests/fxcm-request-timeouts.cjs`，8 项断言通过；`git diff --check` 通过。

最终结论：该 P2 已关闭，无未关闭 Spec 发现。

## 审查边界

审查和本地 VM 测试不替代真实独立整栈验收。用户已授权按当前资源条件继续，独立实例已运行；实际验收状态见 [README.md](README.md)。

## 真实整栈验收后的修复范围

上述独立审查早于实际浏览器验收。后续发现并修复了 SDK inclusive cutoff、41字符目录 ID、已停用同名条目遮蔽，图表库大写 ID 的归一接线，以及周末全空区间请求失败/满300柱inclusive边界缺首柱；新增回归均先复现失败再修复。后续修复由主 agent 自审与真实流程复验，不声称已重新经过独立双审。详见 `evidence/acceptance-fixes.json`。
