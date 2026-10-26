# 长期验收网页登录修复 · 2026-10-25

主入口保持 <https://test.kookvv.com:8443>，沿用原登录密码。图表独立 origin 改为 `https://chart-test.kookvv.com:8443`。Ubuntu `quant-server` / Compose project `mw-issue75-v2-20261018` 继续长期运行。

## 根因与修复

Playwriter 从真实登录表单复现：`/api/login` 返回 200，但图表 iframe 指向 `https://192.168.7.232:18281`，普通浏览器报 `net::ERR_CERT_AUTHORITY_INVALID`，页面停在“正在加载图表”。证据见 [修复前记录](repro-before.json) 和 [修复前截图](playwriter-login-before.png)。

前次业务自动验收使用 `ignoreHTTPSErrors: true`，遗漏了普通浏览器的证书信任检查。前次业务通过不代表该入口的正常 HTTPS 登录已通过，本次明确补验。

本次新增 `chart-test.kookvv.com` DNS-only CNAME 和现有 Nginx Proxy Manager 的图表域名代理 host 27，复用已有通配符证书 certificate 4，将可信 HTTPS 请求转发到原图表上游。主站 host 26 未改变；没有在 Unraid 部署、换版或新建 Market Watch 应用。图表继续使用独立 origin，未改为主站同源路径。

只重建、替换 Ubuntu 验收实例的 Web，构建参数为 `VITE_ADVANCED_CHART_ORIGIN=https://chart-test.kookvv.com:8443`。没有业务实现代码修改、数据库迁移、seed、清库或生产应用发布。风险分类 F0：前端部署地址及 TLS 路由调整，无 schema 或业务协议变更。

## 实际验收

[Playwriter 回归结果](regression.json) 记录最终结果；[登录截图](regression-login.png)、[刷新截图](regression-refresh.png) 可直接查看。

- 使用新隔离浏览器 context，`ignoreHTTPSErrors: false`；通过真实密码表单登录，`/api/login` 返回 200。
- 验证父页、可信图表 iframe 及原生 blob iframe；状态为“已加载 · 行情按需更新”，XAUUSD H4 `dataReady=true`，原生 OHLC 与实际 K 线可见。
- 等待原生初始化设置保存完成后刷新，重复确认图表、OHLC、样式加载完成，无设置草稿提示。
- 页面脚本异常和意外 HTTP 错误均为 0。未登录时 `/api/session` 的预期 401 单独记录。
- 不声称所有浏览器网络事件均为 0：图表取消旧报价/解析、已建立 SSE 的关闭及通知观察上传的两秒预算取消另行记录。报价取消要求匹配图表的取消消息及后续成功报价；未恢复的资源失败仍判失败。
- 初始化期间观察到部分图表资源 `ERR_FAILED`，同一 URL 随后由浏览器重新请求并收到 200；回归逐项核对后续成功响应，并检查最终原生 frame 的全部 stylesheet 已加载。保留失败事件，不将单独 curl 200 冒充浏览器成功，也不声称已查明这些初始请求被替换的全部内部原因。
- 主站和图表域名 curl 均 HTTP 200、`ssl_verify_result=0`，未使用 `-k`。

这是登录、证书与图表刷新专项回归；没有重复完整 FXCM 业务矩阵，也不代表用户人工验收已完成。早期回归脚本遇到表单 hydration、过短冷启动等待，以及把正常取消当失败的问题；另一次过早刷新打断初始化保存，产生仅在测试 context 内的恢复草稿。脚本已等待实际就绪及保存结束，未删除用户草稿或重置偏好。

## 运行版本与现场

- Web：`market-watch-web:fxcm-mwa-login-20261025-r1`，ID `sha256:39fae9ae416a4d9993f25c3258f8726c9b72c3c7cd001026cd8ebf7e52c406ba`。
- 原 Web 回退 ID：`sha256:e52d192d0bf77c4749546afc7876da942680a4958b60e9a8c1f72b8f5c724b4a`，精确 Web-only 回退配置私有保留。
- API/workers 保持 `sha256:1c4380792e7938872548810ccea40ff0b10744b82a11c5e5f7d42afb8d592320`；Chart 保持 `sha256:63542f9ea64b9d094925806df97ac27a7fb68b7b199c70077d1800acf8c339ff`。
- 工作树仍为 `integration/fxcm-mwa-20261025`，基线 `8dd4faf2b5db2a46829d65b9873882b1f09fabc2` 加未提交整合差异；基线不是完整实现 SHA。本次 Web 产品源码沿用原候选，差异为构建参数。

[Web 换版审计](runtime.json)、[最终现场审计](final-audit.json)：仅 Web 容器替换，其他服务身份/镜像及有效配置保持，15 服务运行、API/PG healthy，受保护浏览器身份保持。工作区、告警、指标模板、schema 和原通知状态与原 FXCM 部署基线一致。

原 `operate.py audit` 对 `advanced_chart_preferences` 全表相等断言未通过；未将其改成绿色或回滚数据库。真实原生初始化会保存 `widgetbar.layout-settings`，观察到其 revision 更新，偏好表保持 30 行但指纹变化。事前没有逐行快照，不能断言该表逐字节保持或把全部变化精确归因于本次登录。通用 preferences 也混含运行状态，不声明全表保持。

## 复验与运维

持久回归脚本：[web/tests/mwa-login.playwriter.cjs](../../../../web/tests/mwa-login.playwriter.cjs)。在自己的 Playwriter session 中设置 `state.mwaLoginCheck`，包括 `baseURL`、`chartOrigin`、私有 `authFile` 和绝对 `reportDir`，再运行：

```bash
playwriter -s SESSION -f /home/quant/repos/market-watch-fxcm-mwa-20261025/web/tests/mwa-login.playwriter.cjs --timeout 180000
```

密码只从仓库外的 JSON 文件读取，不写入脚本、日志或截图。脚本关闭自己创建的 context，不修改其他浏览器页面。

原运维入口 `python3 /home/quant/repos/.mwa-fxcm-20261025/operate.py start|status|stop` 保持；candidate 与统一 manager 的当前候选已同步新 Web，原完整 rollback 不改写。上述历史 audit 的偏好字节相等边界以本报告为准，不作为现有状态全部未变的证明。

[FXCM 原业务验收](../mwa-20261025/README.md) · [人工清单](../manual-acceptance-mwa.md)。本次没有提交、推送、PR、合并、生产应用发布或清理长期实例。
