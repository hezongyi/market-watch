# 补丁审查与 Ubuntu 实例验收（2026-10-13）

用户授权执行「1 审查现有补丁、2 Ubuntu 实例验收」，并明确未复现 `Load failed` 时暂不处理，两项已完成。本文及脱敏 JSON 记录提交前的验收快照；用户随后明确授权提交并创建 PR。生产发布仍未执行。

审查对象：`fix/production-pending-20261013`，基线 `1b3e4a2`。范围包含工作树 tracked 差异及全部新增产品文件、测试和证据。需求来自交接文档及[七项方案](production-feasible-solutions-20261013.md)。使用 `code-review` 的两个独立审查轴，并使用 `ui-ux-pro-max` 核对界面验收。

## Standards

文档规范违规：0。AGENTS、CONTEXT、ADR0001 和 Ubuntu 构建/部署约束均已纳入审查。

一个非阻断的低优先级判断：`advanced-host/native-indicator-results.js` 的 `attach` 与 `scope` 重复了私有运行时查找逻辑，可在以后提取 helper。本轮保留实现。

## Spec

发现并修复一个 P2：方案要求「补查应针对实际 unknown 区间」，原入口允许对完整观测或已证实闭市的区间再次读取，消耗每日三次预算。

`backend/alerts/composite_recheck.py` 现在先返回相同请求编号的既有结果，再按当前接受的 `input_revision` 读取分钟，结合目标来源 instrument 的已登记日历判断未知分钟。全部已观测或已证实闭市时，在配额登记和供应商 I/O 前拒绝请求。历史来源闭市证据不能证明目标来源完整；全缺分钟不依赖不存在的聚合 bar 判断。补齐后的同 ID 重试仍返回原结果。

新增单元及实际 PostgreSQL 回归覆盖完整观测、目标闭市、历史来源闭市不能证明目标完整，以及补齐后幂等重试。正确 fixture 在旧代码上为 3 失败、1 通过；修复后通过。Spec 复审确认该问题已解决，剩余已确认问题：0。

两轴结果：Standards 0 项规范违规、1 项可选代码重复建议；Spec 1 项 P2 已修复、0 项剩余已确认问题。

## 验证与部署

- Docker 完整依赖下四组后端测试共 **54 passed**，其中 **12 项实际 PostgreSQL**，每项使用独立 schema；包含来源复核、告警恢复及覆盖完整性。只有只读 pytest cache 警告。共享本机旧 venv 缺少 `yfinance` 的依赖错误不作为产品故障，完整 Docker 测试已通过。
- `git diff --check` 通过。API 使用 `mw-docker build` 重建，明确 task/project/purpose；正常 Compose recreate API 和三个 worker，保持数据与配额。
- 运行 API 文件 SHA256 与工作树一致。API、三个 worker 均引用新镜像；readyz HTTP 200。API 为正常 uvicorn 入口，没有性能 wrapper 挂载、固定 clock 或 pinned-source 环境变量。
- 部署后真实浏览器产品回归通过：Python 值与多输出、LWMA 默认/参数/隐藏、五图 Swing、明暗/折叠/最大化、保存刷新。
- 部署后 UI 回归通过：原生模板及掩码 506、列表明暗 1600/1250/980/720px、焦点恢复、补查表单和现有三次配额、非模态通知。没有重置配额或注入供应商响应；新拒绝分支和成功恢复由实际 PostgreSQL 回归验证。
- UI 首次部署后执行在连续 Esc 关闭窗口的等待断言处超时，未出现 pageerror；未改代码，同一脚本复跑通过。这次波动保留为验收限制，未证明为产品根因或已修复问题。
- 本轮补丁部署前诊断浏览器回归和正常配置下 4 实例/5 次真实补页均通过；补页 0 空白、0 整图 reset。该单样本仅为功能验收，不作为新的同条件性能对照。已有[最终 27 样本矩阵](evidence/production-pending-docker-final-matrix-20261013.json)继续有效，性能与内存限制保持原报告结论。

观测脚本仅监听浏览器 requestfailed/pageerror，不拦截请求，不输出完整 URL 或身份。本轮包括首次 UI 失败及复跑的所有执行均未出现 `Load failed` 或 pageerror；requestfailed 仅记录 `net::ERR_ABORTED`。**按用户决定暂不处理 Load failed；没有声称其网络根因已修复。** 中间版本一次 `Value is null` 的历史风险仍保留，不能以本轮未复现宣称已修复。

脱敏汇总：[本轮审查与验收证据](evidence/production-pending-review-acceptance-20261013.json)、[最终运行环境](evidence/production-pending-final-environment-20261013.json)。凭据、截图、完整浏览器状态和原始输出只保存在 `/tmp/mw-pending-fixes-20261013-private`。

## 可审阅实例

实际主机：Ubuntu `quant-server`；本机 Docker project/task：`mw-pending-fixes-20261013`。Web：<http://127.0.0.1:20271/>；chart origin：<http://127.0.0.1:20272/>。均为主机 loopback 地址，远程浏览器需连接该主机。

从本工作区启动/停止，仅影响本 task：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-pending-fixes-20261013-private/acceptance.env -p mw-pending-fixes-20261013 -f deploy/ubuntu/production-ux.acceptance.yaml up -d --no-build'
sg docker -c 'docker compose --env-file /tmp/mw-pending-fixes-20261013-private/acceptance.env -p mw-pending-fixes-20261013 -f deploy/ubuntu/production-ux.acceptance.yaml stop'
```

实例保留供审阅。生产缺分钟仍依方案第三分支保留 unknown/stale；没有新增真实观测或独立适用闭市证据，未填价格、改告警绑定或改日历。用户随后授权的提交/PR 包含产品补丁、测试和本报告，生产发布需要独立授权。
