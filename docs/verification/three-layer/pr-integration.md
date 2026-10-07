# 三层行情 PR 主线兼容复验

日期：2026-10-07。用户授权推送分支并提交 PR，此前暂缓 PR 的决定已撤销。
完整 A–E 实现验收见[最终核对](completion-audit.md)；长时间质量观察继续暂缓。
本轮将 `origin/main` 的 `c18b219` 合入 `feat/market-data-integration`，不合并到主线或发布生产。

## 合并内容

三个冲突文件为 `advanced-host/Dockerfile`、`build-assets.mjs` 与 `bridge.js`。
资源构建保留三层选品器及主线的同步设置、区间映射和双击放大。
桥接保留完整资产类型、固定输入指标初始化状态，以及主线的区间映射失效保护。
固定历史与组合分页将实际被图表接纳的 bar 送入区间映射；被拒绝的回调不登记。

同步许可补丁测试改用实际 v1.12.0 补丁生成旧候选，避免将新增放大钩子混入旧字节夹具。
另外清理五处导入排序和一处未使用导入、历史来源文件末尾空行；不改变后端业务行为。

## 复验结果

- 合并后后端：**1075 passed /239 skipped /33 warnings /247.23秒**。跳过不算通过。
- TypeScript/Vite 构建成功，实际验收构建指定 `VITE_ADVANCED_CHART_ORIGIN=http://127.0.0.1:16630`；既有大 chunk 提示保留。
- Ruff、JS 语法、工作区和暂存区 diff 检查通过，无未解决冲突。
- 固定行情/指标/修订、同步协调/快照、区间/边缘同步、区间映射/生命周期/外侧标签、保存竞态共11组 Node 检查通过。
- 两组许可补丁合同通过：原版、旧补丁升级、幂等、禁用/回滚、篡改拒绝与缓存URL。
- 实际数据中心桌面审计通过，13个页面/错误状态，930个文字样本；浏览器错误为0。
- 私有生产构建宿主4项双击放大/同步/保存兼容检查通过，使用真实许可引擎及明确标注的合成父RPC与价格。
- 另在实际 Ubuntu Docker web/API/PostgreSQL/chart-origin 验证 H4 自建和组合读取都进入区间映射，选品保留所选层级，浏览器错误为0；专属临时工作区已按实际ID及revision删除。

初轮运行环境错误包括未设 PYTHONPATH、浏览器缺少本机动态库、许可资源未位于检查工具预期路径、构建未指定验收图表 origin。
另有旧同步字节夹具已失效，以及临时核验错误要求当前层级选品返回全部三层。
以上实际修正复验，最终结果如上；没有用失败日志代替最终通过。

## 环境与证据

Ubuntu 本机隔离 Compose project `market-watch-three-layer`，数据中心 <http://127.0.0.1:16629/market-data>，
图表 origin <http://127.0.0.1:16630>。完整启停方式见[最终核对](completion-audit.md)。
本轮只在本机 ignored 目录准备许可资源与私有构建；没有构建无归属 Docker 镜像或操作 unraid。

私有日志在 `artifacts/data-integration`：`pr-main-integration-backend.log`、`pr-main-integration-web-build-final.log`、
`pr-main-integration-host.log`、`pr-main-fixed-series-final.log`、`pr-main-native-hook-contract-final.log`、
`pr-main-maximize-patch.log`、`pr-main-data-center-browser-final.log`、`pr-main-maximize-bridge-after-fix.log`、
`pr-main-maximize-bridge-final.json`、`pr-main-real-chart-verified.log` 与 `pr-main-real-chart-docker-final.log`。
早期环境/夹具失败日志保留。凭据、许可文件及完整私有产物不提交仓库。

长期稳定性、持续容量增长和低频供应商故障仍未完成长期观察；不承诺策略15秒SLA或采样流全tick。
MT4接入后续处理，不包括订单执行、生产部署或生产切换。
