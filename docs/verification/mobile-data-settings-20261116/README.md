# 数据页以维护设置为中心的状态调整

2026-11-16，`feat/managed-live-rollover-20261113` 当前工作树。F0：手机展示与本地支持日志调整，兼容性 TypeScript 字段补充；不修改后端状态、数据存储、采集策略或告警就绪判定。保留此前工作树改动。本次不更新 PR、不运行远程 CI。

## 状态语义与实现

数据管理关注已保存的设置和是否需要干预，不把连接过程当成配置状态。

- `ManagedDataFacts.tsx`：维护设置、维护执行结果与实时开启意图分别投影。任务下载、派生、准备和自动重试期间保持“维护已配置”；失败、部分失败或配置错误保留“维护需处理”。暂停、归档、未配置分别展示。自动重试携带的 timeout 错误不会把已保存的计划标成配置损坏。
- `DataManagedPage.tsx`：列表左侧保留品种身份，增加一行轻量维护状态；开关下方稳定显示“实时已开启／实时未开启”。401、恢复、来源维护、闭市不会覆盖这行配置状态。无法开启时仍显示服务器给出的待配置、待历史、不支持等真实原因，不伪造可用性。
- 已开启但接续配置/准备出错、账户变更或基线保留窗口需要处理时，列表保留“实时需处理”及就地原因。开关仍反映服务器保存的开启状态，不因错误伪装成关闭。
- 详情历史区域明确区分“维护设置”和“最近执行”。成功执行标明成功及时间；覆盖范围、可用周期和维护编辑入口保留。
- 详情实时区域标题只显示开启意图；来源配置保持可见。短期连接状态、确认时间、基线接续及轮换过程收进默认折叠的“最近运行情况”。新报价恢复与分钟线补齐分别解释，不以分钟就绪暗示报价一定新鲜。配置错误与保留窗口警告仍直接可见。
- 页面活动时观察到的异常、恢复及准备状态变化静默记录到“更多 → 日志”；同一挂载期间同一品种同一状态不重复记录，不把离线快照当新事件。仅记录实际观察到的变化，不声称这是服务端完整运行审计。

“已开启”只表示设置，不承诺当前报价、K线、指标或告警全部就绪。现有后端就绪判断保持原有职责。间歇性认证错误的根因不由本次展示调整解决。

## 验证与截图

- [构建](build.log)、[归属标记 Docker 构建](docker-build.log)、`git diff --check` 通过。完整构建保留原有 Vite 资源体积提示，无构建错误。
- [状态规则检查](facts.log)：准备、接收、恢复、认证重试、休市、来源维护不改写开启意图；人工处理状态、基线告警、历史失败、自动重试和离线未知状态分别核对。
- [专项浏览器验证](fixture/proof.json)：5组检查、20张实际构建截图；覆盖状态切换、日志、配置失效、历史自动重试、断网写入保护及恢复；375/412px、深浅主题、100%/150%字号的列表与详情无横向溢出。业务操作仅登录测试夹具，没有写入真实配置。
- [完整流程回归](workflow/proof.json)：17组检查、56张截图，包含创建防重、未知响应核查、维护冲突、直接实时开关、失败回滚、默认来源核对、保留窗口、归档、开图及离线保护。最后补充的历史自动重试边界由上述规则与专项浏览器检查覆盖。
- [日志存储回归](logs.log)：持久化、账号隔离、去重/恢复关联、敏感信息脱敏、容量边界、离线及退出清理通过。
- [旧版本基线失败](baseline.log)：旧部署实际显示“实时运行中”，无法通过新的长期设置断言。[旧列表截图](baseline/failure.png)与[新列表截图](deployed/list-light-375-14.png)可直接比较。
- [部署后真实实例只读检查](deployed/proof.json)：读取18447已有配置，不改开关、不提交维护任务、不改自选；浅色375px、深色412px/150%字号，列表、详情及折叠运行信息共6张截图；无页面异常或业务写入。示例：[详情](deployed/detail-light-375-14.png)、[展开运行信息](deployed/runtime-light-375-14.png)。

复现命令，在 `web/` 目录运行：

```sh
npm run build
node tests/mobile-managed-facts.cjs
node tests/mobile-logs.cjs
MOBILE_DATA_SETTINGS=1 MOBILE_DATA_OUTPUT=/tmp/mw-data-settings-check node tests/mobile-data-workflow.browser.cjs
MOBILE_DATA_OUTPUT=/tmp/mw-data-workflow-check node tests/mobile-data-workflow.browser.cjs
MW_SETTINGS_OUTPUT=/tmp/mw-data-settings-real-check node tests/mobile-data-settings.real.cjs
```

真实实例脚本只允许本任务18447；登录从本机私有凭据目录内部读取，不打印凭据。测试浏览器忽略证书检查，部署脚本另用 APK 内置 CA 严格验证 HTTPS、readyz、实际 HTML、全部手机壳资源及 APK 下载校验和。浏览器视口截图不代表 Android 真机验收。

## 部署

Ubuntu 本机 Docker，**https://192.168.7.232:18447/m/data**。

- 镜像 `market-watch-web:mobile-data-settings-20261116`，最终摘要 `sha256:3b2a88f62f4d58736c2edba4fe9a42a18fc3590d8c9bd003e8b6d034fa98c3bf`。
- 手机壳版本 `b11387dfc82e7536`。APK仍为0.1.4，无需重装，在“更多 → 检查更新”应用网页更新。
- [部署核查](deployment.json)确认仅 web 容器重建；API、market-runtime、data-worker、数据库及 TLS 容器身份与镜像保持。维护自动重试边界在首轮部署后补齐，初轮记录见 [deployment-initial.json](deployment-initial.json)。
- 构建使用 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:mobile-data-settings-20261116 --task mw-managed-live-rollover-20261113 --project mw-managed-live-rollover-20261113 --purpose acceptance`。显式根 context 与当前 Dockerfile 的 COPY 路径一致，避免本机工具旧默认 web context 漏包。

启动/停止沿用私有目录 `/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/` 的 `start.sh` / `stop.sh`。

原版本私有配置保留在该目录 `mobile-data-settings-20261116-backup/`；首轮候选配置保留在 `mobile-data-settings-20261116-final-backup/`。如需回到本次修改前，只将 run.json 与 compose.json 的 web image 恢复为 `deployment.json` 的 `originalPrevious`，再执行：

```sh
docker compose -p mw-managed-live-rollover-20261113 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json \
  up -d --no-build --no-deps web
```

无需回退数据或重启采集服务。
