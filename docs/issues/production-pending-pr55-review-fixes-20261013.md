# PR #55 指标审查修复与复验

本轮接续用户授权“修复这些问题，然后复审，直到可以合并”。审查基线为 main `687fb0c`；已将该 main 合入分支。未执行 PR 合并或生产发布。`Load failed` 未复现，按用户决定暂不处理。

## 修复

原 Spec 审查发现三个 P1：固定指标进度没有 `name` 导致 pending 被登记完成；同时间戳形成中柱没有 numeric revision 导致 Python 曲线不刷新；撤去 MWPY 订阅后缺少可见窗口外的递归计算前缀更正证据。

现在以返回结果的具体 calculation/run 判断完成状态，参数不同的同名算法独立恢复；接受的尾柱 OHLC/完整性变化驱动重新读取；可见消费者在共享价格订阅上登记计算前缀，更正只撤下指标结果，保持主图窗口和共享价格任务。隐藏、删除和 dispose 释放需求，重连保存消费水位。

复审另修复：组合前缀使用已交付输入水位，普通尾部追加不重复失效；published managed 前缀使用发布快照证据；前缀证明与输入在 PostgreSQL REPEATABLE READ 下读取，避免旧值接受新证明；轮询回退携带初始证明并只确认一次；指标需求不复用 managed 的已完成 1 秒缓存；工作区请求白名单转发 calculation_origin/dependency_before；原生大写固定 UUID 与 datafeed 小写键统一规范化。

## 验证范围

- main 整合后 208 项后端测试通过，包含实际隔离 PostgreSQL、固定指标、managed、stream、组合告警及补查回归。
- 最终后端产品修复版本定向 136 项通过，包含真实 PG 双连接并发更正回归。只读 mount 的 pytest cache 写入警告不影响结果。
- 七项 JavaScript 合同脚本通过：实际进度形状、多参数 pending、同柱变更、managed numeric 修订域、已完成响应缓存、轮询一次性证明、共享读取、历史事件、请求校验、身份及重连水位。
- API/chart/Web 镜像经 `mw-docker build` 构建；正常 Compose 更新 API、history/chart-history/native-history/market-stream worker。API 关键五个文件 SHA256 与源码一致；HTTP host 包含最终 bridge/coordinator 原文。
- 实际 shared stream worker＋HTTP/PG/Python/native 图表定向测试通过：managed 同柱变更、可见窗口外 EMA 前缀更正、Python 值一致、主图 reset 为 0；两个新参数固定历史任务 pending→complete。
- 真实浏览器产品和 UI 回归通过：Python 值、多输出、五图 Swing、保存刷新、原生范围及模板、响应式列表、补查和非模态通知。

先前失败记录保留在任务私有目录：旧代码两项后端合同跑红；初轮 stream 77 通过、固定修订报价一项失败，main 整合后的相关回归通过；首次新定向测试读取旧 chart 镜像，后续检查暴露 parent whitelist 丢字段并修复；固定冷启动进一步发现原生大写 UUID 键不匹配，修复后完成真实新参数验收。nested sg 无权限时由 runner 执行同 task fixture，浏览器保持实际请求及订阅。最终 UI 复跑曾因其他业务通知同时存在、总提示数为 3 而失败；测试改为定位并关闭自己的 synthetic 提示后通过，保留原失败。最终完整定向、产品及 UI 结果见配套 JSON。旧性能矩阵只代表原验收代码，没有重新测量这些修复后的性能比例。

## 独立双轴复审

Standards：0 已确认规范违规。低优先级可选 Duplicated Code 为 native adapter 两处运行时查找重复，可后续提取，不阻断。

Spec：原三个 P1 及本轮确认的凭证竞态、旧响应复用、轮询重复失效、请求字段遗漏均已修复。最终独立 Spec 复审无剩余确认阻断，Standards 0 违规。结果见 [脱敏证据](evidence/production-pending-pr55-review-fixes-20261013.json)。

## Ubuntu 验收实例

实际主机为 Ubuntu quant-server，Compose project/task 为 `mw-pending-fixes-20261013`。Web `http://127.0.0.1:20271/`，许可图表 origin `http://127.0.0.1:20272/`；隔离数据库为 `production_ux_acceptance`。使用本机私有 env：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-pending-fixes-20261013-private/acceptance.env -p mw-pending-fixes-20261013 -f deploy/ubuntu/production-ux.acceptance.yaml up -d'
sg docker -c 'docker compose --env-file /tmp/mw-pending-fixes-20261013-private/acceptance.env -p mw-pending-fixes-20261013 -f deploy/ubuntu/production-ux.acceptance.yaml stop'
```

实例保留供审阅，没有清理其他任务资源。凭据、许可库、完整浏览器状态和截图不提交。新增定向浏览器使用显式 task-local synthetic 发布行情，仅验证业务链路，不代表生产来源价格、覆盖或生产告警恢复。长期观察仍未进行。
