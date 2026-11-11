# 守望 Android 外壳（A 阶段）

对应应用基线 v2.0.5 / A06；本目录是新建工程，不恢复归档 Android 工程。

- applicationId：`com.kookvv.marketwatch`，versionCode：`1`，versionName：`0.1.0`。
- 工具链：JDK 17、Gradle 8.11.1（wrapper 固定 distribution SHA-256）、AGP 8.9.2、Kotlin 2.1.20、compile/target SDK 35、min SDK 26。
- AndroidX Activity 1.10.1、WebKit 1.13.0。本机 SDK 35 assembleDebug/lintDebug 已通过；Find X8 待用户验收。
- 首次输入可信 HTTPS origin，打开同源 `/m/`。禁止明文、混合内容、文件和 content 访问；证书错误取消；release 禁用 WebView 调试。
- Kotlin 只持久保存服务器地址；Cookie 由 WebView 管理，业务缓存和单图设置只用网页 IndexedDB。
- 主框架、来源限定的 WebMessageListener 协议 v1 只用于返回/退出/连接配置/清会话及壳版本；没有原生业务数据桥。

在已安装 SDK 35、JDK 17 且磁盘预算充足的环境执行：

```sh
cd mobile/client
./gradlew :app:assembleDebug :app:lintDebug
```

Debug APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。首次构建通过，lint 为 0 errors / 12 warnings（版本更新建议、中文资源化、图标/备份规则及已做运行时特性检查的提示）；不设 lint baseline。Debug 专用网络安全配置仅为 `192.168.7.232` 增加本任务公共开发 CA；私钥在 gitignored `.tools/dev-tls/`。Release 不包含该配置或 CA，仍使用系统信任链。发行签名使用仓库外的私有文件，当前未配置发行签名、未验收覆盖升级。不要提交 `local.properties`、签名文件、凭据或完整浏览器状态。

本机工具位于任务自己的 `.tools/android-sdk`、`.tools/gradle`。下载的官方 Gradle 8.11.1 distribution 已校验与 wrapper 相同的 SHA-256。设备 `adb devices -l` 当前为空。开发候选地址为 `https://192.168.7.232:18445`，不占用既有 `mw-dev:18443`。

Find X8 验收需记录 Android / ColorOS / WebView、APK hash / 签名指纹 / 源码 SHA，以及真实 HTTPS 登录、原生返回/旋转、进程回收、SW/IDB、同签名升级与 ntfy 实收。桌面 Chromium 的触屏模拟不能替代这些项目。
