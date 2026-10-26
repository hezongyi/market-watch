# 价格轴加号菜单修正验收

用户明确批准更新；自动验收及用户人工验收均通过，任务已收口，实例保持运行。F0：兼容 UI 触发流程修正，无 API/schema 变更。

实际主机 Ubuntu `quant-server`，Compose project `mw-issue75-v2-20261018`。入口 https://192.168.7.232:18280/advanced-charts/mw75-real ，Chart origin https://192.168.7.232:18281 。

## 实际版本与行为

仅更新 Chart：干净源码 `a641f019f916ee5e3febdb05f4b9351484e9c0e3`，镜像 `sha256:3e70f41f82a5e527978daa27d48f043835e3d4c334e5a6ec659417aad96a7130`，通过 `mw-docker` 构建。Web 保持 `19cc026a`，API 保持 `b4e1326a`，workers 保持 `8b7ee3ee`。

点击价格轴加号仅打开原生选择菜单；选择“在 <价格> 创建告警”才以捕获价格创建，不填输入框。关闭菜单不创建。原生绘制水平线选项保留。

## 验证结果与边界

- 从固定候选镜像提取全部资源，以许可图表和合成行情／接口实测：点击加号无创建、Escape 关闭无创建，再次点击并选择告警后仅创建一次，价格匹配且无编辑器。没有源码替换，没有真实数据库测试写入。
- 真实实例使用临时浏览器 context，实际点击 BTCUSDT 价格轴加号弹出“在 80,448.65 创建告警”；Escape 关闭后无创建请求。现有 17 条规则、8 条日志、编辑取消、tooltip、四图标独立 hover、圆点及深浅色背景回归通过；告警配置与版本保持，页面异常 0。
- 实际返回 `/host.7c49dd744cc8550d.js` 与镜像内制品逐字节一致。SHA256 `7c49dd744cc8550d1734d19b40b2f55edc4796da2065a71ed4c6101de44fc394`。
- 15 个服务 running，API/PG healthy；所有有效环境、挂载、端口、网络及重启配置保持。其余 16 个容器（含两个 exited 初始化容器）的 ID/启动时间、保护浏览器身份保持；六张保护表内容指纹保持。
- 浏览器持久工作区／偏好／通知写入均隔离；真实实例只测菜单打开和取消，创建专项使用固定镜像加模拟接口。真实写入后的最终人工确认留给用户。

原始构建、镜像身份、前后配置审计、结构化结果和截图：`/home/quant/repos/.reports/market-watch/20261024-alert-axis-menu-acceptance/`。真实菜单截图 `runtime/real-axis-menu.png`，固定镜像创建测试 `native/result.json`。

## 运维与回退

- 统一启动／状态／停止：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`，持久引用已同步；此前告警任务的 start 引用也同步，避免降版。
- 本次 Chart 启动／状态／停止及只读审计：`python3 /home/quant/repos/.mwa-alert-axis-menu-20261024/operate.py start|status|stop|audit`。
- 本次私有配置与回退：`/home/quant/repos/.mwa-alert-axis-menu-20261024/`。`rollback-override.json` 精确保留更新前 Chart 镜像 `6946f86b25a3`；仅可结合原 base 对 Chart 执行局部回退，不整栈 recreate。未执行回退。

保留长期实例、数据库、凭据、TLS、真实数据及浏览器现场。无 seed/migrate/reset、PR、push、main 合并或生产发布。

## 人工验收与收口

2026-10-24T23:25:43Z，用户明确确认“人工验收通过，可以收口了吗”。人工验收完成，无剩余阻断。只读收口审计再次确认 Chart 固定镜像、全部有效配置、其他容器及保护浏览器身份保持，15 服务运行、API/PG healthy。未再次换版、重启或执行资源清理；保留代码、验收证据和回退材料。未扩大为合并 main 或生产发布授权。
