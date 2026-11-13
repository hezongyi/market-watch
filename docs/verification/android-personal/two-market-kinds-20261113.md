# 手机端原生／自建两分类

分支 `feat/android-personal-v205` 已 rebase 到 `v2.0.10`，随后按用户要求直接迁移手机端分类。实现按 F0：使用新版既有 API，不修改后端业务或数据库 schema，不保留手机端三分类入口及旧目录快照读取。代码与部署包含此前保留的手机 UI 工作。

## 行为

- 数据页与自选的“搜索品种”都只有“原生／自建”两个页签；共用 shadcn Tabs、来源筛选、详情和分组控件。
- 原生读取原生价格系列目录；自建直接读取 `/market-data/center/dataset-summaries`，按数据集显示一条，不把固定版本和实时接续列为两个并列品种。来源筛选、搜索和分页分别使用各自接口合同。
- 自建列表展示实时接续状态与历史截止时间。点击详情、加入自选或开图时，读取当前数据集与 `/datasets/{id}/continuation`：未开启接续时使用可用周期对应的发布版本，已开启时使用当前默认接续身份，不任取旧配置。
- 已开启但尚未就绪的接续不自动退回固定历史；显示原因并禁止加入/打开，仍可明确进入固定历史版本查看。未发布数据也能查看状态，不伪造可用系列。离线/缓存详情不能提交需要最新身份的自建操作。
- 自选的原生来源/中文名称解析、告警类型和实时接续提示统一新版术语；手机源码不再显示“平台／组合”分类。现存精确系列身份按 v2.0.10 协议使用，未重写用户自选或告警引用。
- 目录与详情使用新的本机快照命名空间；获取目标和读取偏好后再次检查会话，避免切换服务器/账户后提交旧页面动作。
- 375px / 150% 字号截图发现搜索长代码被截断，增加按可用宽度换行；真实截图发现首次显示来源标签偶尔空白，改为直接显示当前选项标签。

## 验证

本地完整 `npm run build` 通过。以下实际构建页面浏览器回归通过，均无页面异常：

```sh
cd web
MOBILE_DATA_OUTPUT=/tmp/mw-two-kinds-final-acceptance node tests/mobile-data.browser.cjs
node tests/mobile-watch.browser.cjs
MOBILE_VISUAL_OUTPUT=/tmp/mw-two-kinds-watch-visual node tests/mobile-watch-a07.browser.cjs
node tests/mobile-alerts.browser.cjs
```

数据页回归覆盖375/412px、深浅主题、150%字号、搜索/来源/分页、任务/来源/版本、嵌套返回、离线与重试、分组保存冲突；新增验证仅两个分类、单数据集行、自建分页、固定/实时精确身份、准备中与未发布限制、自选搜索已有固定历史不阻挡选择实时接续、重复加入不重复写偏好、首次显示来源标签。偏好写入只发生在 HTTP 测试夹具。

两轮截图检查记录：第一轮 `/tmp/mw-two-kinds-final/` 暴露大字号搜索长代码裁切；后续 `/tmp/mw-two-kinds-delivery/` 验证换行，Ubuntu 真实首次显示又发现来源标签偶发空白；最终构建补上选项标签与首次显示断言。归档精选截图、fixture proof 与构建日志见 [证据目录](two-market-kinds-20261113/)。完整截图位于对应 `/tmp` 输出目录，归档不包含每张重复截图。

Ubuntu 实例只读验证数据页与搜索的两分类、真实原生目录和详情、真实自建空态；该实例没有符合汇总条件的自建数据，因此真实自建详情/接续不作已验证声明，由上述明确夹具覆盖。浏览过程中仅有登录、查询准备/取消、报价和订阅等正常读取链路，没有保存自选、处理事件、创建任务或修改告警。Android WebView 的实际触摸仍待真机确认。

## Ubuntu 验收部署

- 主机：Ubuntu quant-server；project/task：`mw-android-personal-v205`。
- 地址：<https://192.168.7.232:18445/m/>；APK 在“更多 → 检查更新 → 更新页面”获取本版。
- API、数据、市场和通知运行组统一使用本分支候选镜像；Web 使用本次构建。精确镜像与 Shell 见证据目录 `deployment.json`。
- 更新前约9.3GiB可用内存、15GiB磁盘余量；复用本任务原PG、网络、端口和TLS，只更新本任务服务。新基线将原API内后台循环拆为市场/通知运行组，因此补齐这两个服务，并更新数据运行组；未连接其他任务的数据库。
- 验收实例无 OANDA 凭据，保留关闭实时报价的配置。初次运行组继承旧 `rest_batch` 导致 pricing 初始化退出；已在本任务市场组改为 `stream` + `stream_enabled=false`，随后稳定运行，pricing 如实为 disabled，其余活动循环 idle。自动切换原配置关闭，因此对应缺失心跳不当作活动循环失败。
- 数据库备份位于私有目录 `before-two-kinds-20261113.dump`，4,120,314 bytes，`pg_restore --list` 603行，仅验证归档可读，不宣称做过完整恢复。原运行配置保存在同目录 `before-two-kinds-{run.json,live-data.override.json}`，权限0600。没有删除旧镜像、数据库或volume。
- 静态与API `/readyz` 200，运行组心跳、Shell指纹与无页面异常证据归档。未跑CI、未推送、未更新PR、未操作Unraid。

仅操作本任务实例的启停命令：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait api data-worker market-runtime notification-worker web

docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  stop api data-worker market-runtime notification-worker web
```
