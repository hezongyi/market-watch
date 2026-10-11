# PR #37 修复与再次复核（2026-10-11）

结论：**可以合并，未发现剩余阻断项**。不代表供应商线上可用性或生产部署已经验证。原审查 head `3b05da7` 的两个缺陷及复核中发现的关联失败／reset 边界已修复。最新 main `75f8f34` 已合入 PR 分支；集成后最终产品提交 `400062f` 的24个产品／测试文件与独立集成 checkout 逐文件哈希相同（API/Web已测试树一致，新增native-navigation已重建并在真实浏览器验收）。

## 修复

- 日历按实际通道、环境、账户、报价口径、原生参数、版本和适用 profile 区分；同身份跨周期汇总。Python 与 JSON3、bid 与 ask、smooth 参数分别保留，缺少证据的实际系列显示 unknown。通用规则日期和适用范围继续保留。
- HTTP、worker status/error、失败报价行和 polling 均保留同绑定最后成功价格与时间；固定历史也显示失败提示，成功后恢复。明确不同 revision/input_revision/source_identity 不借用旧报价，首次失败不制造价格或时间。
- 独立 reset token 封住首次无缓存时 reset 后旧请求返回的空缓存漏洞；成功／拒绝逐 ticker 校验，工作区 epoch 和订阅对象继续隔离撤销和替换。

## Standards

独立规范复核 0 个阻断。原Python身份遗漏与后续 bid／ask 参数遗漏已关闭；reset token 生命周期未发现明确规范问题。没有用纯风格建议阻断。

## Spec

独立需求复核 0 个阻断。失败保留与文案、固定历史、真实失败报价行、恢复以及首次空缓存 reset 已逐项验证。独立VM执行真实 reset 事件，HTTP／poll 的成功与拒绝四种迟到结果均没有回调、错误回调或旧缓存写入。后续native范围恢复及其超时亦经两位复核通过。无范围扩张。

## 验证

Ubuntu本机Docker，task `mw-pr37-fix-20261011`，Compose project `mw-pr37-fix-ubuntu-20261011`，独立网络／PG volume／数据库／端口。API和Web由独立main集成checkout构建，许可chart由PR工作区构建；全部使用 mw-docker / market-watch-ubuntu，未访问unraid。

后端13套相关回归 **237 passed**，包括main历史价格精度集成；21项日历回归、新失败／reset、HTTP迟到及取消回归、38项价格格式、Ruff、Node语法、diff检查通过。早期测试容器没有测试目录及辅助文件，已修正挂载后全套重跑；不是产品失败。

浏览器使用受控供应商历史 fixture 和真实API／PG／worker／固定许可原生UI，不认证供应商线上可用性。新增实际Python日历库存和原生market-event失败、恢复、旧世代、失败报价行、固定历史提示断言。记录初次容器更新导致native-ready timeout，以及完整流程D1出现的一次原生nearestIndex错误；两者不能计为通过。独立15次周期加载无页面错误；等待完整历史／范围操作后仍复现；定向日志证明tick标签map与旧bounds不一致。已在既有native-navigation continuation适配层等待一致刻度并逐帧重试，保留原deferred和最新请求隔离，不改标签／索引／价格；30秒仍不一致会明确拒绝并提示重试。新增回归在旧实现失败，新实现覆盖等待、恢复、替换和超时结束。独立复核用真实clearNativeWait重放1797帧，超时后拒绝一次、通知一次、队列清空。修复后完整浏览器一轮 **41场景、页面错误为空**，并断言范围deferred完成。末次加强检查的运行同样完成41功能断言、六个周期匹配且可见范围有效、页面错误为空；最终runner因两条预期“已取消旧图表的历史加载”导航通知被要求为空而失败。独立复核确认其对应HISTORY_CANCELLED，现有bridge已有明确忽略规则。已修正harness按code单独记录取消；该分类修正没有再次启动验收环境重跑，不能声称末次runner已green。原始[失败报告](verification/market-session-details-pr37-fix-20261011/browser/browser.json)及[分类判断](verification/market-session-details-pr37-fix-20261011/browser-assessment.json)均保留。

验收访问地址为 `https://localhost:17443/advanced-charts`，图表来源 `https://127.0.0.1:17444`，仅绑定Ubuntu回环地址。启动／停止：

```bash
sg docker -c 'docker compose -p mw-pr37-fix-ubuntu-20261011 -f /home/quant/repos/market-watch-market-session-details-impl-20261010/docs/verification/market-session-details-pr37-fix-20261011/compose.yaml up -d --no-build'
sg docker -c 'docker compose -p mw-pr37-fix-ubuntu-20261011 -f /home/quant/repos/market-watch-market-session-details-impl-20261010/docs/verification/market-session-details-pr37-fix-20261011/compose.yaml stop'
```

私有env/TLS/登录材料在 `/tmp/mw-pr37-fix-20261011`，不提交。退役后需要重新生成私有材料和任务镜像，以上地址不再运行。

## 接续与范围

PR #37 的功能与本次修复可以合并；没有将PR合并进main或执行生产发布。历史两轴报告保留原request-changes及复现证据，已标注修复前状态。下一步是合并此PR；正式发布需按新授权走生产流程。日历官方证据维护仍按既有记录持续进行，未知来源／账户和未来未核实假日不升级为已认证。

## 退役完成

任务PG已备份并在临时数据库实际恢复，表行数及内容指纹相同，来源在归档期间稳定；私有归档保留在Ubuntu用户目录。`mw-docker retire`已精确删除本project的7个容器、独立网络／PG volume及无引用任务镜像，没有清理其他任务。地址现已停止，私有env/TLS未提交。[退役结果](verification/market-session-details-pr37-fix-20261011/retire-applied.json) · [PG恢复验证](verification/market-session-details-pr37-fix-20261011/pg-restore-verification.json)。
