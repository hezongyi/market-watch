# 切换周期时“处理设置草稿”提示修复

状态：已修复并更新既有 mwa，记录时间 2026-10-24T14:53:41.691685+00:00。分类 F0：兼容的 Web/Chart 展示与草稿状态调整，无后端或数据库 schema 变化。

## 问题与处理

切换周期会保存 `chart.lastUsedTimeBasedResolution`，部分首次操作也保存 `widgetbar.layout-settings`。适配器先写本机草稿，再提交设置，成功后删草稿。此前页面依据“有任意草稿”显示人工处理入口，把正常在途备份当成异常。实际旧部署四次切换、六次成功保存仍出现六次提示，最终没有遗留草稿。

现在保留所有在途备份，但只展示明确失败的版本与页面打开时发现的遗留版本。适配器在最终失败后发送 `draftFailed`，按 storageKey/version 标记，409 有界重试期间不提示；成功删除仍按版本校验。失败标记早于错误通知去重，重复失败不会被隐藏。此前没有可选 `failed` 字段的草稿仍可恢复。采用原生恢复选择后仍要求重新打开图表，避免旧 widget 回写覆盖用户选择。

没有使用延时或防抖掩盖提示，也没有自动丢弃任何真实失败草稿。

## 验证

- 实际部署的 Web/Chart、真实数据和许可库；全新临时浏览器，服务端工作区／偏好与通知写入由测试代理拦截，设置使用一致的影子存储。
- H1 → H4 → D1 → H1：正常保存提示 **0 次**；阻塞保存响应时，本机备份存在且提示仍为 0，放行后草稿清除。
- 注入一次 HTTP503：失败草稿被标记，提示出现；刷新后保留，可明确采用服务器设置，再重新打开后消失。
- 注入 HTTP409：两次有界尝试后显示处理入口，恢复选择正常。
- 模拟旧版无状态字段的中断草稿：刷新后显示恢复入口，选择、清理与重新打开正常。
- 页面未捕获异常为 0。回归覆盖跨 writer、过期失败／成功不能影响较新版本、失败删除、重复相同失败、队列与版本冲突等。
- `tsc -b`、Web/Chart 标准构建、原有偏好／通知／请求队列测试通过。NR 加载连续性联合回归、通用 runtime 及许可原生 NR 双 study、保存布局、D/W、字号颜色、隐藏删除回归通过。
- 未重跑全量后台套件；未修改金融算法，不扩展此前数值或 Pine 对照结论。

旧部署的浏览器失败记录位于原始证据 `baseline/result.json`；[本地回归失败](regression-red.log)与[通过记录](regression-green.log)保留。

## 运行与保护

- Ubuntu `quant-server` / `mw-issue75-v2-20261018`，主入口 `https://192.168.7.232:18280`，Chart origin `https://192.168.7.232:18281`。
- 产品提交 `970a2550f0b93678f55f8c4e2bc075be2d965698`；仅 Web 和 Chart 替换。Chart `sha256:35caa82add5234177f8a9f2bcf5a62eb47969d3499f4c5b8842e079a48c83d2d`，Web `sha256:f0cdc23874d832e0c6a53d78fb5ac540167bc3b91708a11df822452e8e8cfd1c`，均为干净源码构建。
- 实际加载 `host.cb6e3450bb4e723d.js` / `index-HmjF6z1w.js`。Web origin 已从候选镜像的真实编译产物核对，而非仅依赖构建标签。
- API/10 workers 仍为 8b7ee3ee / `sha256:089fbb3cb00aa453b30053661ad77cb5000b86bea8738782d2df086e311b8772`，没有替换。
- 15 服务运行，API/PG healthy，restart 0。有效环境、挂载、端口、网络、资源、DB/gateway/其他服务及保护浏览器身份保留。
- 六张保护表完整内容哈希保持；原 23888 条通知查看／处理状态、7 条手机确认保持。期间新增 1 条通知，不声明通知整表静止。
- 当前观察窗口 API 有 16 处 CancelledError、8 个 traceback 标记；Web/Chart 无 traceback，HTTP500／池超时／重启计数为零，不声明全栈零异常。
- 统一运维：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`；本轮审计：`python3 /home/quant/repos/.mwa-preference-draft-banner-20261024/operate.py audit`。
- 本轮回退 overlay `/home/quant/repos/.mwa-preference-draft-banner-20261024/rollback-override.json` 与旧 durable overlay 均私有保留；未执行回退。旧 NR 任务记录是历史证据，当前运行版本以本轮记录和实例 registry 为准。

原始证据：`/home/quant/repos/.reports/market-watch/20261024-preference-draft-banner`；结构化结果见 [summary.json](summary.json)。此前用户已认可的 NR 闪动修复保留于本候选基线，回归通过。没有 push、PR、main 合并、正式 tag、生产／Unraid 操作或永久数据删除。

## 用户确认与收口

2026-10-24T14:55:42.353908+00:00：用户确认“正常了”，本轮修复收口。最后运行配置与保护浏览器审计通过，保留 mwa 运行、原数据及回退材料。没有合并或生产发布授权。
