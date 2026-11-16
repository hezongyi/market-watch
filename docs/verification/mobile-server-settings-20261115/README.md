# 更换服务器原生 UI · 2026-11-15

已实现并交付 APK 0.1.4（versionCode 5），分支 `feat/managed-live-rollover-20261113`。分类 F0：原生表单及返回交互调整，无服务端接口、schema 或行情策略变更。

- 地址配置保持原生离线可用，首次连接、登录换服务器、连接失败后的设置共用 `ServerSettingsView`。
- 对齐手机端深浅主题、白底 logo、字体、圆角输入框、蓝色主按钮和 44dp 图标触摸目标。
- 单一 HTTPS 地址输入，保留原服务器地址，支持清空、键盘连接；打开时不自动弹键盘。
- 地址错误在字段下方替换辅助文字，修改后恢复；提交防重复。返回按钮返回原服务器，系统返回在键盘打开时优先收起键盘。首次配置返回退出。
- HTTPS origin 校验与切源清 Cookie/WebStorage 流程沿用原实现。不会保存未提交地址。
- 可滚动表单，最大宽度 460dp，适配窄屏、大字号和缩小视口。

## 验证

`assembleDebug`、`lintDebug`、4 个既有更新清单单元测试及 2 个原生渲染/交互测试通过。lint 为 0 errors / 16 warnings，涉及 WebView 特性检查、依赖建议、备份配置、程序创建的 View 构造器和 KTX 建议等，不将 warnings 表述为零。

14 张截图覆盖 375/412、深浅主题、错误、首次配置、空地址、150% 字号及 380px 高度视口。截图由 Robolectric 4.14.1 / Android API 35 Native Graphics 渲染真实 Kotlin 控件，不是网页重绘，也不是模拟器或真机截图。离屏画布显式计入根 ScrollView 的滚动偏移，窄视口断言确认滚动后连接按钮完整可见。

交互验证：错误地址不提交、编辑后清除错误、只提交一次、提交中禁止返回、返回不触发连接、沿用 HTTPS/用户信息/路径/查询参数/片段限制。没有改动真实用户数据。

验收脚本通过 init script 为测试添加 Robolectric，依赖不进入 APK；本机 Maven Central 存在 TLS 握手失败，验证脚本使用 Google 托管的 Maven Central 镜像。

```sh
cd mobile/client
# 按本机环境设置 ANDROID_HOME / GRADLE_USER_HOME，并使用 Gradle 8.11.1。
./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest --max-workers=2 \
  -I ../../docs/verification/mobile-server-settings-20261115/native-render.init.gradle
```

最终源码指纹、lint 和测试统计见 `checks.json`；签名见 `signature.txt`，与旧版 0.1.3 的 SHA-256 证书指纹相同。检查下载完整性见 `delivery-check.py` / `delivery.json`。

## Ubuntu 验收交付

- 主机：Ubuntu 本机 Docker；project：`mw-managed-live-rollover-20261113`。
- 访问：<https://192.168.7.232:18447/m/>。
- 新 APK：<https://192.168.7.232:18447/downloads/market-watch-0.1.4-debug.apk>。
- 更新入口：连接上述验收服务器后，“更多 → 检查更新”。本次只更新已有只读 downloads 挂载目录中的 APK 与清单，APK 先落地、清单原子替换，旧包保留；不需要替换网页镜像或重启服务。
- 启动：`bash /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh`。
- 停止：`bash /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh`。
- 已使用 APK 信任 CA 验证 HTTPS、readyz、网页、清单 no-store、版本、APK 大小与 SHA-256、下载内容等于实际构建、缺失 APK 返回 404。

未部署 Unraid，未更新 PR 或远端 CI。真机仍需确认输入法遮挡、系统返回及同签名覆盖安装后的实际体验；本地原生渲染不能替代这些检查。
