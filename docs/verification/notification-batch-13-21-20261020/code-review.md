# 独立代码审查与返工

比较基线：`fb33f3a873d29403c6ae5d7de80eecdd160f80cb`。范围为第 13–21 项，包括分隔线整合提交及本批产品改动。按 AGENTS.md 的 F1 要求，使用 code-review skill 的独立 Standards / Spec 两轴审查；不恢复旧任务编排。

## Standards

1. P1：三方合并后错误地把远端贡献字段当成本窗口已观察内容，下一次本地回调会回退远端字段。已将成功基线内容保留为本窗口实际 wanted；连续保存回归通过。
2. P1：旧已加载 JS 不认识 `notice_owner=server`，仍按 listener/profile 放大。已在后端从真实 listener+generation 和可靠失败 Audit 判断来源，只确认去重、不创建重复事故、不接受浏览器恢复主来源；旧待同步 GET 可确认投影。
3. 对第二项的返工复审发现：仅有健康任务 Preference 不能证明捕获了旧积压故障。已改为要求报告发生时存在可靠失败证据；健康先到、故障后上传的真实故障保留。取消 tombstone 仅保留归属，不恢复需求。

最终独立 Standards 回执：此前两项 P1 均关闭；相关后端独立运行 **36 passed**；未发现新增阻断。

保守兼容边界：旧世代已删除、无法证明归属或浏览器时钟偏差时保留浏览器事件，可能留下额外历史故障；不得宣称任何历史积压都能完全归并。

## Spec

1. P1：load reset 先增加 epoch 后结束请求观察，使后端上下文不匹配。已在旧 epoch 下先 unsubscribe / ended，再发 reset；执行真实 bridge handler 前缀的顺序回归通过。
2. P1：固定图表库会将模板保存拒绝转为 fulfilled error 并关闭原生窗口。已对所有模板写入口独立 report + rethrow，错误明确“设置未保存”，包括只读拒绝；原 adapter 及冲突回归通过。
3. P2：浏览器直接退出不保证 React cleanup，不能仅靠 unsubscribe。真实 Chrome reload 证明卸载时异步 IndexedDB 不可靠，已改为正常运行时持久化结束意图，退出同步记录 document 关闭标记；其他页/下一启动将其放入有序 outbox。原 context 与未恢复语义保持；真实 reload 持久化回归通过。

Spec 独立复审确认：模板提示和旧 epoch 顺序已修，无交易确认副作用。最终页面退出实现的复审回执另行追加。

代码审查通过不替代原生 UI、实例业务、静态依赖及候选 CI 验收。相关结果见本目录 README。

## 最终实例验收返工与复审（b32c2f8）

真实原生失败注入发现：此前adapter独立report仍走type:error，普通旧错误通道不再呈现，用户仅看到泛化失败。新增实际adapter→真实bridge callback回归在旧HEAD明确失败（error != notice-source），修复后通过。

所有公开偏好写入口（含savePreference）统一最终outcome；父preferences RPC使用requestAPI，避免在adapter决策前产生重复泛化事故。失败进入notice-source原生浮窗，成功按同kind/name/tool/operation恢复；save/delete分离。每次入口同步捕获scope，异步完成校验workspace/session/epoch，旧结果不污染新工作区。回归涵盖网络单次写、只读零写、直接设置、成功恢复以及挂起RPC后切scope的成功/失败。

Standards和Spec分别独立复审上述最终差异，三个偏好窄测试均独立重跑PASS；两轴均报告**最终通过、无剩余明确阻断**。Spec此前页面退出竞态亦已独立复审通过（原子fault+intent及真实reload回归）。历史刷新已有problem现在可见，保留缓存行。

最终新候选实例实拍确认“设置未保存”可见、写失败不落库/不盲重试、只读0次写，及刷新503保留100行并显示错误。审查通过与业务实拍、CI分别记录，不互相替代。
