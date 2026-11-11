# Android personal v2.0.5 独立审查

固定比较基线：`1bb935bdf1195c4da532cb2e6f62faca2198e6c4`；B/C 实现快照：`fed47b1b`，并复核本次未提交修复。按仓库 F1 要求，使用 [code-review skill](/home/quant/.agents/skills/code-review/SKILL.md)，Standards/Spec 独立只读 agent 审查，未改代码。规范来自 AGENTS.md、冻结方案与契约核对。

## Standards

- P1：迟到登录可重新激活已退出会话。已用请求 generation/AbortController、恢复边界检查关闭。
- P2：迟到自选保存能写回已清除缓存。已在页面及 IDB 事务内校验 profile generation；同账号重新登录不会复活旧请求。
- 修复复核曾发现 P2：刷新取消登录后 busy 不复位。已在 refresh 复位，并由 signingOut 保留退出流程的 busy 所有权。新增延迟登录取消测试通过。
- 终次只读复核：原问题均关闭，未发现本次修复新增的实质问题。

## Spec

- P1：不可达地址困住 APK。主框架网络/HTTP/证书/TLS 握手错误均提供重试和连接设置；证书仍取消。握手遗漏在复核后补齐。编译/lint 已过，真实 WebView 故障入口仍待设备检查。
- P2：SSE 断线缓存仍显色。清除对齐状态，重开后读取新快照，保留共享 provider 的 generation/sequence 校验。浏览器验证断线灰色、重开未对齐仍灰色、新快照恢复。
- P2：已打开告警详情不随后台读取更新。按 ID 从当前规则派生；不再存在的规则标待确认。浏览器验证状态/次数同步。
- P3：未记忆自选滚动位置。按分组在手机 IDB 保存并恢复；重载测试通过。
- 终次只读复核：四项均关闭，未发现可确认的范围扩张。

Standards：原始 2 项、复核新增 1 项，全部关闭；Spec：原始 4 项及握手遗漏，全部关闭。真机、真实供应商、ntfy 与覆盖升级门槛仍未通过，审查关闭不代表交付验收完成。
