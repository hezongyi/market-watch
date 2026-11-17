# 手机后台通知设置与 App 直达验收（2026-11-17）

风险分类 F0：兼容的设置 API、发布 worker 与手机界面/Android 入口修改；无数据库 schema 迁移。开发验收只使用 Ubuntu 持久 `mw-dev`，保留用户数据及当前通知目标，不改 Unraid 生产环境。

## 行为与边界

- 更多 → 后台通知：共享服务器地址、主题、可选令牌和启用开关，保存后 worker 动态读取。令牌不回传、不进入审计；留空保留，显式操作移除。配置采用 revision 防止并发覆盖。
- 检查连接仅验证服务健康；发送测试、服务接受、手机实收分开显示。测试绕过自动推送关闭及安静时段；启用自动投递不补发积压旧提醒，保留历史。
- 手机支持报告已收到，原有 ntfy 确认按钮继续工作。点击通知只导航，不自动确认或标记已处理。
- 新通知的 click 使用 `marketwatch://notification`。告警直达手机触发详情；异常与系统通知进入对应事件分类；测试通知打开后台通知设置。已发送通知中的旧链接不能追溯改写。
- APK 0.1.5 / versionCode 6 注册单任务入口，冷启动经桥接交付路径，热启动复用现有 WebView。只允许已保存的 HTTPS 服务器和限定手机路径，跨服务器不自动切换。有未保存表单时等待关闭，专业图表沿用既有离开确认与保存。登录过期后保留落点，详情失败可重试。
- 此任务仅替换通知跳转到旧页面的入口；不删除 `/advanced-charts` 路由。与任务基线 ba10541f 比较，`web/src/advanced` 与 `advanced-host` 无差异，专业图表告警模块与设置保留。

## 已完成验证

- `PYTHONPATH=backend <venv>/bin/python -m pytest -q backend/tests/test_notification_transport.py backend/tests/test_notification_test.py backend/tests/test_notify.py backend/tests/test_chart_alert_notifications.py backend/tests/test_chart_alert_api.py`：40 passed，1 skipped（条件性测试，未计为通过）。
- 此前独立 PostgreSQL 的通知配置并发与真实告警/投递生命周期验证：5 passed；没有在持久开发库做故障注入或修改真实规则。
- `npm --prefix web run build` 通过。`mobile-ntfy.browser.cjs`、`mobile-more.browser.cjs`、`mobile-notification-link.browser.cjs` 通过。
- 桥接浏览器夹具覆盖冷启动登录、热启动与重复点击、跨历史分页的指定记录、未保存草稿、读取失败重试、系统分类及无确认写入。夹具不等同 Android 系统点击验收。
- 更多/通知界面覆盖 375/412px、深浅主题、150% 字号、短视口，截图及无溢出检查通过；实际开发实例的认证页面也已核验。
- `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` 通过，6 项 JVM 测试全部通过。新旧 APK 签名一致，Debug 开发 CA 与 HTTPS 实例 CA 一致。
- 实例下载清单为 0.1.5，可信 CA 校验通过，APK 大小、SHA-256 与清单匹配。真实后台 worker 已发布一次 App 直达测试，ntfy 订阅读回确认 click 字段正确；用户此前已确认新主题可实收，本版通知点击仍待升级后真机确认。
- 部署前后规则 ID、状态、版本、轮次、次数与控制修订指纹一致；市场运行、数据 worker、数据库、TLS 与 ntfy 容器未重建。

## 开发实例与回退

- 地址：`https://192.168.7.232:18443/m/`，实际运行于 Ubuntu 本机 Docker。
- 启停：`mw-dev up` / `mw-dev stop`。实际配置由 launcher 指向私有 run.json；仅替换 API、notification-worker 与 Web 镜像。
- 私有候选与证据：`~/.local/share/market-watch-dev/updates/mobile-ntfy-20261117/`。回退使用其中 `run.before-links.json` 的对应服务镜像及 `android-update.before-links.json`；操作前对照现状，勿整体覆盖其他任务后续配置。APK 下载目录是持久只读挂载。
- 手机验收：在更多 → 检查更新覆盖安装 0.1.5，发送新的测试通知，先在 App 后台点通知，再在 App 关闭后点通知，确认均直接回 App；真机系统唤起、安装权限及覆盖安装保留数据不能由 JVM/Chromium 代替。

## 域名与一键确认修复（同日追加）

- 截图中的 `CertPathValidatorException: Trust anchor for certification path not found` 来自 ntfy 自身的 TLS 校验；APK 的开发 CA 信任不会传给 ntfy。短暂采用“去 App 确认”的中间实现已撤回，保留通知内 HTTP 一键确认。
- 经用户指定，fnOS Lucky 的 `quant.kookvv.com:8443` HTTPS 子规则重新开启，上游由旧停用实例改为 Ubuntu `https://192.168.7.232:18443`。读回逐字段比较，只改变此子规则 Enable 与 Locations；原有来源白名单、其他路由、证书及 DDNS 保留。私有前后快照在 fnOS `/var/backups/market-watch-quant-20261117/`。
- 公网证书由 Let's Encrypt 签发，SAN 覆盖 `*.kookvv.com`，有效期至 2027-01-31；系统默认信任链和域名校验通过。域名默认解析、fnOS 公网 NAT 回环和 LAN 定向解析的 `/readyz` 均为 200。没有以跳过 TLS 校验作为通过证据。
- 开发实例公开地址改为 `https://quant.kookvv.com:8443`；App 需要在服务器设置里切换为此地址，无需新 APK。新增可选 `ALERTS_NTFY_CALLBACK_URL`，未配置时沿用公开地址，允许 App 内网 origin 与公网确认地址独立配置。
- 最终交互：点通知正文只打开 App；点“确认测试”或告警“确认”发送带通知专用凭证的 HTTPS POST。App 内确认入口仍保留。确认单次告警只停止该事件后续通知，不暂停规则，不停止之后的监控。
- 后端通知/告警回归 40 passed、1 skipped；真实已部署手机设置从新域名认证并发送一次测试，ntfy 读回验证 click 指向新域名 App 深链，action 是新域名 HTTPS POST。公开回调的无效凭证探针返回应用预期 403，证明路由和 TLS 可达，没有确认真实通知。
- 用户反馈通知按钮可以打勾；核对时最新这次测试仍未记录 ack，不能将设备显示直接声明为该测试的服务器确认成功。后续以对应 test_id 的 ack_at 与确认审计为准，不模拟用户确认。
- 本次最终 API/通知 worker 镜像 `sha256:605ee68c0782fd0e8bb612be46c87e14519e6784e502b47562331d53862a2f5a`；Web 恢复使用原一键确认说明的镜像 `sha256:210ddf1726317ee23f3c0f3b34c9fdf7f8c1c7895db0178951ad8dc7e1b512a8`。私有 launcher 候选 `run.candidate-domain.json`；回退仅选择对应服务旧镜像及地址配置，不整体覆盖其他后续任务。
