# FXCM 更新长期验收实例

状态：应用已更新，真实业务自动验收通过；人工验收待用户。

- 主机 Ubuntu `quant-server`，Compose project `mw-issue75-v2-20261018`，逻辑实例 `mw-acceptance`。
- 入口 <https://test.kookvv.com:8443>，当前图表 origin `https://chart-test.kookvv.com:8443`；沿用既有登录密码。原 IP origin 因证书不可信已替换。
- 候选工作树 `/home/quant/repos/market-watch-fxcm-mwa-20261025`，分支 `integration/fxcm-mwa-20261025`，基线 `8dd4faf2b5db2a46829d65b9873882b1f09fabc2` 加未提交差异；没有最终实现提交 SHA。
- 后端以更新前实际运行 API `7beee58f3729` 的代码为底，整合 FXCM；前端保留手机 Chart r10/Web r7 的已核对源码，再整合 FXCM。不能将旧 FXCM 独立实例镜像直接覆盖长期实例。
- 精确文件摘要见 [source-identity.json](source-identity.json)，固定镜像及更新服务见 [candidate-images.json](candidate-images.json)。

2026-10-25 登录修复补记：前次浏览器验收忽略 HTTPS 错误，漏掉原图表 IP 证书问题。现已只替换 Web 为 `sha256:39fae9ae416a4d9993f25c3258f8726c9b72c3c7cd001026cd8ebf7e52c406ba`，改用可信独立图表域名，并使用正常证书校验完成 Playwriter 真实表单登录、原生 K 线及刷新复验。上述 candidate-images 是原业务部署历史，当前 Web 及审计以 [登录修复记录](../mwa-login-fix-20261025/README.md) 为准。

## 验证

- 后端定向回归 84 passed；独立任务 PostgreSQL 回归 22 passed。
- 前端专项 19 passed，TypeScript 和本次25个后端文件 Ruff 通过；三套镜像构建通过，Web 既有 bundle 大小警告保留。
- 真实目录 517 品种；EUR/USD、XAU/USD 各 M1/H1/D1、20柱及20柱翻页通过。
- 自建 EUR/USD UTC0：120 根 M1、H4，重复 request_id 复用，增量发布与旧版本 manifest/bars 不变。
- 桌面真实平台图、自建固定版本图及均线、嵌入目录通过；pageerror 0。
- 自然到点日更已自动发布 `b5ff4cac-6f50-4117-9c87-48f064b779bd`，parent 链正确；暂停/恢复通过，最终计划已暂停。
- 手机390×844真实页面单图计数1，pageerror0；OANDA H1兼容读取另见 compatibility.json。

业务证据 [business-result.json](business-result.json)、[mobile-smoke.json](mobile-smoke.json)、[compatibility.json](compatibility.json)，截图同目录。

## 现场保护与边界

[保留审计](preservation.json)：15服务运行、API/PG healthy；现有有效环境、命令、用户、挂载、端口、网络、资源限制及重启策略保留，仅后端新增4项FXCM配置和3个只读挂载。数据库、网关及保护浏览器未重建，5张受保护业务表全表内容指纹、已有通知状态和 ay52 schema 保持。

以上是原业务部署时点的审计。后续真实登录初始化保存了原生 widgetbar 布局设置，`advanced_chart_preferences` 指纹变化，不能把原来的“五表保持”结论延伸为当前全表相等；工作区、告警、指标模板和 schema 仍匹配原基线，详见登录修复的 final-audit.json。

通用 preferences 表混合保存业务设置与运行状态，其整表指纹在观察期间变化。事前未采集逐key摘要，因此不声称该表所有用户设置逐字节未变；独立 advanced_chart_preferences、工作区、告警等已核对，登录和有效配置也已单独验证。

浏览器采用新临时 context，不使用保护 profile；现有工作区文档仅在该 context 中临时替换为FXCM图表，持久写入被拦截，现有工作区与偏好内容不变。仅新FXCM样例行情、缓存及任务写入真实数据库。图表自动保存被阻止时临时页面可出现草稿提示，不代表改写原用户现场。

验收按阶段执行。最初测试运行缺少记录样本，且误选了其他任务后续开发中的测试；补齐样本并选择与已部署实现相符的测试后84项通过。前端初次从错误工作目录运行，改到web后19项通过。OANDA兼容脚本最初假设旧响应存在顶层source字段；按既有目录身份核对后复验，不涉及产品代码修复。不将这些过程表述为单次全绿。

独立实例已有五分钟空闲验收，本次长期实例未重复该五分钟全空闲观察。远程CI、完整D1 DST相位、官方quota和SDK再分发许可等边界沿用原FXCM记录；未提交、未创建PR、未合并或发布生产。

## 当前启停和审计

```bash
python3 /home/quant/repos/.mwa-fxcm-20261025/operate.py start
python3 /home/quant/repos/.mwa-fxcm-20261025/operate.py status
python3 /home/quant/repos/.mwa-fxcm-20261025/operate.py stop
python3 /home/quant/repos/.mwa-fxcm-20261025/operate.py audit
```

start/stop只涉及本轮13个应用服务，不清库。当前固定候选和精确旧镜像回退文件均私有保留。统一manager的candidate引用已同步本轮13服务；历史rollback不改写。其他历史任务专用start/rollback不作为当前统一入口。

[人工验收清单](../manual-acceptance-mwa.md)。
