# 守望 Android 外壳（A 阶段）

对应应用基线 v2.0.5 / A06；本目录是新建工程，不恢复归档 Android 工程。

- applicationId：`com.kookvv.marketwatch`，versionCode：`1`，versionName：`0.1.0`。
- 工具链：JDK 17、Gradle 8.11.1（wrapper 固定 distribution SHA-256）、AGP 8.9.2、Kotlin 2.1.20、compile/target SDK 35、min SDK 26。
- AndroidX Activity 1.10.1、WebKit 1.13.0。工具链尚待本机 SDK 构建和 Find X8 核定。
- 首次输入可信 HTTPS origin，打开同源 `/m/`。禁止明文、混合内容、文件和 content 访问；证书错误取消；release 禁用 WebView 调试。
- Kotlin 只持久保存服务器地址；Cookie 由 WebView 管理，业务缓存和单图设置只用网页 IndexedDB。
- 主框架、来源限定的 WebMessageListener 协议 v1 只用于返回/退出/连接配置/清会话及壳版本；没有原生业务数据桥。

在已安装 SDK 35、JDK 17 且磁盘预算充足的环境执行：

```sh
cd mobile/client
./gradlew :app:assembleDebug :app:lintDebug
```

Debug APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。发行签名使用仓库外的私有文件，当前未配置发行签名、未生成 APK、未验收覆盖升级。不要提交 `local.properties`、签名文件、凭据或完整浏览器状态。

Find X8 验收需记录 Android / ColorOS / WebView、APK hash / 签名指纹 / 源码 SHA，以及真实 HTTPS 登录、原生返回/旋转、进程回收、SW/IDB、同签名升级与 ntfy 实收。桌面 Chromium 的触屏模拟不能替代这些项目。
