# v1.8.0 连续历史加载发布

本版本包含已合入 main 的 PR #7 连续历史、可调容量、超限真实边界定位和加载提示，以及合并后审查发现的共享取消与 PostgreSQL 超时修复。版本按兼容新增功能升至 1.8.0；正式发布使用不覆盖的附注标签。

## 本次修复

- 图表导航代次只解除该图自己的边界消费者；同来源的其他有效图表继续补齐。消费者离开时同时释放其原生交付等待，只在最后消费者离开时取消整个任务。回最新的图不被其他图的完成结果反向移动。原生补读保留已有定位消费者；填充释放请求标记后恢复排队订阅，并持续原生交付至实际缓存前缀，防止把中间一次完成当作最终边界。供应商故障保留现有数据边界和补齐未完成的反馈。
- PostgreSQL 快照仍使用 REPEATABLE READ，并通过统一数据库预算事务将 SQLSTATE `57014` / `55P03` 转为超时。历史加载接口返回 503 / `HISTORY_TIMEOUT` / `history_boundary:false`，超时后可继续正常读取。
- 三项原有 VM 回归补充 `requestAnimationFrame`，恢复历史观察、请求生命周期与行情系列检查。

确定性边界回归覆盖共享补齐、单图回最新、另一图真实定位、原生交付等待、排队订阅、多轮交付、成功/失败补读及原有取消/卸载/预热路径。`web/tests/advanced-shared-boundary.browser.cjs` 使用真实许可原生引擎、合成24×7数据与公开导航/回最新接口，证明双图补齐与供应商失败，不替代 Ubuntu 容器和真实供应商验收。接口回归在真实读取查询处注入 SQLSTATE，验证错误及恢复；真实 PostgreSQL 用例通过 `pg_sleep` 触发 statement timeout，须在独立 Ubuntu Docker 数据库执行后记录结果。

## 发布要求

Ubuntu 是开发和验收环境；Unraid 仅用于用户已授权的正式发布。采用独立 worktree、Compose project、网络、volume、数据库及端口，保留现有候选与其他任务。生产正式切换前核对受测源码、许可钩子安装和内容版本、包版本、逐服务镜像 ID 及源码提交。

生产基线为 `v1.7.0` / `q18_yahoo_catalog`。本次先停止本项目写入并生成新数据库及私密配置备份，核对 SHA 和实际恢复，再执行兼容迁移 `r19_native_history_loads`；迁移前后原业务表计数和用户状态指纹保持一致，新表为空。不删除行情缓存，不修改用户布局、密码、通知配置或 Yahoo 开关。

启动匹配的 API/web/chart/backup 镜像，新增独立服务 `native-history-worker`，命令为 `python -m alerts.native_history_loads`，关闭该服务的业务通知投递。原 `chart-history-worker`、`chart-aggregation-worker`、实时与通知服务保持职责。默认单源 200,000 根、工作区加权 800,000 根，服务端页数、响应与时间保护同时生效。能力上限并不保证任意指标组合或低配置设备性能。

切换后检查 schema、实际镜像、API 健康、历史 worker、行情/通知心跳和队列进展，通过正式域名执行只读登录、页面和原生图表检查。生产验证不创建预警、不改密码、不发送测试通知、不保存用户布局。结果和构建映射归档至 `deploy/releases/v1.8.0-production.json`。

## 回退

保留 v1.7.0 镜像、standalone Compose、active-release 和备份脚本。新版本异常时先停止本项目写入及新历史 worker，备份当前状态，恢复旧服务组合并重启 web。`r19` 只新增任务表，旧版本可保留该表读取原数据；回退不自动 downgrade 或恢复旧数据覆盖用户新增状态。正式发布所需临时备份/回滚实例在稳定确认后按准确项目归属清理，保留数据库备份与旧镜像。

## 执行状态

修复 PR [#8](https://github.com/hezongyi/market-watch/pull/8) 已于 2026-10-05 22:52:36 UTC 合并，main 合并提交为 `b700911cff0b6f8448ac54e4355524891238efa8`。附注标签 `v1.8.0` 已推送并固定指向该提交；标签对象为 `2e38c11f69252c5cef7a6e91126ec5f79a996d93`。后续证据提交只更新文档，不移动标签。

已完成的复审证据见 [检查记录](verification/native-history/release-v1.8.0/checks.json) 与 [原生双图浏览器结果](verification/native-history/release-v1.8.0/shared-boundary.json)。两轴独立复审均为0项具体问题；后端453通过、38跳过，48项前端模块套件通过，真实引擎合成浏览器2项通过。权限恢复后，独立 Ubuntu Docker PG14 的35项真实数据库回归、q18→r19迁移和36表备份实际恢复通过；真实OANDA四图完整产品回归通过。详见 [Ubuntu 验收记录](verification/native-history/release-v1.8.0/ubuntu-acceptance.json)。

Ubuntu 验收实例 project `mw-release-v180-20261006`，独立 PG14、网络和卷，访问地址 `https://192.168.7.232:16643/advanced-charts`、图表来源 `16644`。启动/停止：`sg docker -c 'docker compose -f /home/quant/repos/.acceptance/release-v1.8.0-20261006/compose.yaml up -d'` / 将 `up -d` 替换为 `stop`。通知投递和Yahoo关闭。私有登录/env/许可资源保存在该目录，不进入Git。旧验收项目和生产未用于本次测试。

## 正式生产结果（2026-10-06，新加坡时间）

生产在 07:03:39 完成切换。正式网站为 `https://trade.kookvv.com:8443`，独立图表来源为 `https://charts.kookvv.com:8443`；运行主机为 Unraid，项目 `trading-alerts`，active-release 为 `releases/v1.8.0-b700911`。四类正式镜像均由标签提交另行构建，源码标签、版本、镜像 ID 和八个常驻服务的实际核对见 [生产清单](../deploy/releases/v1.8.0-production.json)，固定部署配置见 [Compose](../deploy/releases/v1.8.0-production.yaml)。API healthy，常驻服务重启计数为0；专用 native-history-worker 运行且通知投递关闭，既有生产通知配置保留。启动/停止在服务器项目根目录执行 `./tools/docker-compose -f compose.release.yaml up -d --no-build` / `./tools/docker-compose -f compose.release.yaml stop`；停止会中断生产服务，仅用于正式维护。

迁移前后的35张业务表记录数和6项用户状态指纹保持一致，新增 native_history_loads 表为空。958,948根供应商缓存保留。上线后复查布局、偏好、预警、账户凭据和通知设置一致，没有新增改密码或测试通知事件。市场与通知心跳新鲜，M1采集推进。上线初期自建历史有不连续覆盖，随后正常恢复任务补齐；759个导入任务全部完成，三品种覆盖恢复连续，发布队列曾清至0，已发布柱数从35,403增至39,329，发布终点推进。实时形成桶会继续加入队列，不将一次空队列视作长期无积压保证。

升级前 `alerts-20261005T225831403168Z.dump` 的35表、升级后 `alerts-20261005T230453983832Z.dump` 的36表均在 Ubuntu 独立 PG14 实际恢复并与清单一致。前者按原 q18 schema 核对实际表，不迁移恢复库；后者运行标准 `alerts.backup --restore-check`。两份私密配置归档均完成 SHA-256、Ubuntu 隔离解包、`.env` 与生产一致/0600、Compose `config --quiet` 检查；没有启动恢复出的生产服务，临时恢复库和解包目录已清理。v1.7.0 镜像、回退配置和备份保留；每日03:00 cron已核对，尚未观察新版下一次定时运行。

正式域名的未登录浏览器检查通过：登录表单可见、网站和图表域名200、未认证session401、图表域名API404、CSP禁止图表来源网络连接，390px登录页无横向溢出或脚本错误。2026-10-06 07:49:12 新加坡时间，使用用户提供的当前凭据完成正式登录后只读浏览器验收：Secure/HttpOnly Cookie、历史演练和设置页面、既有单图布局原生数据就绪、continuous 模式、390px主页无溢出、图表来源无凭据泄漏，脚本／接口错误均为0。原生储备读取均200且无供应商HTTP尝试；实际单源200,000／工作区800,000容量配置已核对。

验收会话已退出，随后session返回401；临时凭据文件已删除。验收后只读复查布局、偏好、预警、密码和通知设置保持一致，8个常驻服务无重启、API健康、市场／通知心跳新鲜。旧 import_heartbeat 仍为 stale，专用图表历史worker不发该旧指标；实际进程及导入／发布进展已单独核对。生产只读验收完成；四图大历史、取消、修订和故障注入的完整产品回归仍以此前 Ubuntu 隔离实例证据为准。最终结果见生产清单。
