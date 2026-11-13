# 守望 Android 外壳（A 阶段）

当前应用基线 v2.0.6 / A06（最初从 v2.0.5 实施，2026-11-11 按用户要求变基）；本目录是新建工程，不恢复归档 Android 工程。

- applicationId：`com.kookvv.marketwatch`，versionCode：`4`，versionName：`0.1.3`。
- 工具链：JDK 17、Gradle 8.11.1（wrapper 固定 distribution SHA-256）、AGP 8.9.2、Kotlin 2.1.20、compile/target SDK 35、min SDK 26。
- AndroidX Activity 1.10.1、WebKit 1.13.0。本机 SDK 35 assembleDebug/lintDebug 已通过；Find X8 待用户验收。
- 首次输入可信 HTTPS origin，打开同源 `/m/`。禁止明文、混合内容、文件和 content 访问；主框架网络/HTTP/TLS 失败提供重试与连接设置，证书错误取消；release 禁用 WebView 调试。
- Kotlin 持久保存服务器地址与上次显示主题；Cookie 由 WebView 管理，业务缓存和单图设置只用网页 IndexedDB。
- 主框架、来源限定的 WebMessageListener 协议 v1 用于返回/退出/连接配置/清会话、壳版本及手动应用更新；没有原生业务数据桥。
- 系统栏、刘海与键盘空间由原生容器统一处理并消费 insets；网页使用已避让的 WebView 视口。启动图标复用网站浅色主题的绿色 Waves 图形，白底 adaptive icon。
- 0.1.3 通过 `appearance-v1` 将网页深浅主题同步到原生安全区和系统图标；浅色背景为 `#f8f9fc`，深色为 `#101317`，保持现有安全区尺寸。

在已安装 SDK 35、JDK 17 且磁盘预算充足的环境执行：

```sh
cd mobile/client
./gradlew :app:assembleDebug :app:lintDebug
```

Debug APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。首次构建通过，lint 为 0 errors / 12 warnings（版本更新建议、中文资源化、图标/备份规则及已做运行时特性检查的提示）；不设 lint baseline。Debug 专用网络安全配置仅为 `192.168.7.232` 增加本任务公共开发 CA；私钥在 gitignored `.tools/dev-tls/`。Release 不包含该配置或 CA，仍使用系统信任链。发行签名使用仓库外的私有文件，当前未配置发行签名、未验收覆盖升级。不要提交 `local.properties`、签名文件、凭据或完整浏览器状态。

本机工具位于任务自己的 `.tools/android-sdk`、`.tools/gradle`。下载的官方 Gradle 8.11.1 distribution 已校验与 wrapper 相同的 SHA-256。设备 `adb devices -l` 当前为空。开发候选地址为 `https://192.168.7.232:18445`，不占用既有 `mw-dev:18443`。

Find X8 验收需记录 Android / ColorOS / WebView、APK hash / 签名指纹 / 源码 SHA，以及真实 HTTPS 登录、原生返回/旋转、进程回收、SW/IDB、同签名升级与 ntfy 实收。桌面 Chromium 的触屏模拟不能替代这些项目。

## 应用内手动更新（0.1.2 起）

“更多 → 检查更新”同时检查网页更新和 APK。旧 0.1.1 需要先手动覆盖安装一次。APK 更新仅读取当前可信 HTTPS 服务器的 `/downloads/android-update.json`；不跟随重定向。清单包含包名、递增 versionCode、versionName、同目录 APK 文件名、字节数、SHA-256 和更新说明。

用户确认下载后，校验大小、摘要、包名、版本和与已安装应用相同的签名。下载可以取消；已校验的同一文件可复用。首次需在系统设置允许此应用安装更新，再由 Android 安装界面确认。使用 cacheDir 与 FileProvider，不需要外部存储权限。更换服务器或销毁 Activity 会取消下载；不支持静默安装。

每次交付递增版本、使用同一签名构建，完成 `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` 和 apksigner 验证，再执行：

```bash
python3 mobile/client/package_update.py --notes '本版更新说明'
```

脚本将 APK 和清单放入 gitignored `web/vendor/downloads/`；随后按仓库规则构建并部署 Web 镜像，安装包与清单一起更新。不要手工填写未构建的版本或摘要。清单响应 `Cache-Control: no-store`，不存在的下载路径返回 404。

更新清单边界与网页桥接测试已通过；原生下载、权限跳转、系统安装器及覆盖安装保留数据仍需真机验收，不能以 JVM/Chromium 检查代替。
