# v1.25.4 主 SSE 重复 reset 修复生产交付

PR [#62](https://github.com/hezongyi/market-watch/pull/62) 与发布元数据 [#63](https://github.com/hezongyi/market-watch/pull/63) 已合并。附注标签 `v1.25.4` 已推送，发布源码为 `42b4864b0153ed4419c35d17f77241b163735ad4`，生产证据作为后续独立提交，不移动标签。

## 生产切换与数据保护

正式实例运行在 Unraid `192.168.7.33`，Compose project 为 `market-watch`，复用既有 PostgreSQL 14；Ubuntu 仅构建镜像和恢复备份。应用为 https://trade.kookvv.com:8443/ ，图表为 https://charts.kookvv.com:8443/ 。没有在 Unraid 创建开发或验收临时实例。

四类镜像从干净标签源码经 Ubuntu `mw-docker` 构建，生产导入后逐项验证 RootFS、有效 Config 和源码标签。发布使用生产固定镜像 ID。以根 `compose.production.yaml` 生成配置并与旧版逐项核对，保留现有 native-history-worker OANDA stream 开关，以及代理、数据库、端口、资源设置和 `.env`。远端展开后除镜像外服务配置一致，11 个后端定义 Yahoo 均为 true；切换后 10 个常驻后端实际 Settings 与代理均通过核对，AAPL 元数据、58 根 D1 和报价实际读取通过。

切换前主机曾出现可用内存不足 500 MB、负载约 178，旧版 API 已 unhealthy；没有操作其他业务或虚拟机。主机恢复正常后才启动停写。UTC 2026-10-14 **15:36:44–15:52:18**（UTC+8 23:36:44–23:52:18）停写，共 **934 秒**，包括最终备份和完整恢复校验。

最终 dump `alerts-20261014T153646075482Z.dump` 为 2,755,261,219 字节，SHA256 `666a299c6457fdfebc9cdcba587808d178de44819a58874de9362795dc0a03fb`。配置归档为 `config-20261014T154217Z-CcwuGq.tar.gz`；数据库/配置哈希与大小及归档路径安全检查通过，`.env`、旧 Compose、active-release 完全一致。Ubuntu 独立 project `mw-v1254-restore` 的 PG14 完整恢复成功，89 张备份表行数与 10 项业务指纹一致，恢复库约 9.87 GB。schema 保持 `au48_display_indicator_tasks`，本版无需新迁移。

生产 `active-release` 为 `releases/v1.25.4-42b4864`。12 个常驻服务运行、零重启，API healthy，后台源码与正式标签逐模块哈希一致，图表 host 和关键脚本与发布源码一致。切换前后保存工作区、偏好、监控、告警配置、组合、实时映射和账户/通知指纹一致；未创建告警、发送通知测试或修改密码。

## 登录网页和 M1＋Supertrend 观察

使用用户提供的凭据登录生产；凭据只存私有目录。主页、专业图表、回放、设置及 390×844 手机视口检查通过，无页面错误、失败响应和横向溢出，session secure/httpOnly。图表使用实际生产 HTTP、主 SSE、接受确认与许可原生图表。

在只读手机模式的独立浏览器会话临时切到 `MWP:EURUSD` M1，并通过原生 API 添加 **守望 Python SUPERTREND_PINE_V1**。未保存修改；屏蔽工作区/偏好等写入路由，并只在观察会话停用 autosave。该场景是单图、默认参数、无拖动；不外推到桌面多图和其他指标。

观察 UTC **15:54:12.757–16:09:52.416**（UTC+8 23:54:12.757–次日 00:09:52.416），实际 **939.659 秒**；数据采样覆盖 934.08 秒。结果：

- 15 次新分钟，55 次尾柱值变化；4,533 次原生数据采样，0 未就绪、0 空尾柱、0 时间回退或柱数缩减。
- 主 SSE 经 parent 交付 63 个 bars 和 3,405 个 quotes；0 reset。61 次接受确认全部 HTTP 200；观察从稳定初始历史后开始；上述事件计数包含初始化，观察窗口内为 60 个 bars、3,376 个 quotes 和 58 次 HTTP 200 接受确认。
- 原生 resetData/resetCache/reloadHistory 均为 0。Supertrend 4,533 次采样均有数据，465→480 根，55 次尾部值变化。
- 4,547 次实际 canvas 采样未见清空；开始、第 10 分钟和结束截图人工确认 K 线、趋势线和 Buy/Sell 标记显示正常。
- 0 pageerror、0 HTTP 失败、0 采样错误。记录到 12 次大于 250 ms 的渲染帧间隔，最长 1.05 秒；不将“未闪”表述为完全无卡顿。

录屏 10 Hz 解码 9,840 帧、984 秒，已显示图表覆盖 955.2 秒；K 线消失候选为 0。严格 Supertrend RGB 阈值出现 6 个单帧候选，逐一查看前后帧确认趋势线始终存在；压缩导致颜色偏移，宽容绿色检测各帧仍有 450–602 像素，确认消失为 0。录屏逐帧分析结果见下方证据；10 Hz 只能支持“本轮未观察到”，不保证检出短于约 100 ms 或局部细微重绘。真正历史修订触发 reset 的行为仍保留；本轮未注入生产历史更正。

API 日志有 3 个 `asyncio.exceptions.CancelledError`，均位于历史查询客户端断开检测；其他服务零 traceback。网页无对应失败响应，记录该既有取消日志行为，不把生产表述为完全无错误日志。

## 操作与回滚

在 Unraid `/mnt/user/appdata/market-watch`：

```bash
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build
./tools/docker-compose -p market-watch -f compose.release.yaml stop
bash deploy/main-sse-reset-v1.25.4-switch-20261014/rollback.sh
```

回滚先备份当前数据库，再恢复本次保存的旧 Compose 与 active-release，启动 v1.25.3；无需 schema 降级。正式/回滚镜像和备份保留。已精确删除生产端本次 api/web/chart/backup 导入 tar 和 source.tar.gz；正式/回滚镜像、数据库/配置备份及切换脚本保留。Ubuntu 恢复 project 已停止，恢复卷保留：`mw-docker retire` 预览拒绝此正式发布任务（只支持登记的 acceptance task/project），未绕过工具删除。发布构建任务已登记完成，其他开发/验收实例未改动，不执行全局 prune。

[固定镜像清单](../deploy/releases/v1.25.4-production.json)、[正式 Compose](../deploy/releases/v1.25.4-production.yaml)、[恢复校验](verification/main-sse-reset-v1.25.4-production/database-restore.json)、[业务状态](verification/main-sse-reset-v1.25.4-production/production-state.json)、[运行核对](verification/main-sse-reset-v1.25.4-production/production-runtime.json)、[网页检查](verification/main-sse-reset-v1.25.4-production/production-browser.json)、[M1 数据](verification/main-sse-reset-v1.25.4-production/m1-analysis.json)、[Supertrend 与 SSE](verification/main-sse-reset-v1.25.4-production/m1-study-analysis.json)、[录屏分析](verification/main-sse-reset-v1.25.4-production/m1-video-analysis.json)。完整会话、dump、env、凭据、原始录像/截图和许可库未提交。
