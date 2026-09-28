# 守望 Android 提醒应用

本应用复用 ntfy 的到达广播作为同步提示，也每 5 秒向已配对的网站同步未确认事件。网络请求只访问用户配置的 HTTPS 网站；不会根据外部广播中的 URL 或内容直接响铃。

## 已验证与未验证

- 已通过 Java 计时状态机测试：响 15 秒、停 30 秒、次数上限、静音打断、确认停止、持久化时间恢复。
- 已使用 Android API 35 官方 SDK 编译 APK，并通过 APK v2/v3 签名验证。
- **尚未在 OPPO 真机安装运行，不能将编译成功视为锁屏/后台可靠性验收。**

## 使用

1. 在网站「提醒与设置」生成设备配对令牌，记录 HTTPS 网站地址与令牌。
2. 安装 `artifacts/android/market-watch-reminder.apk`，输入地址与令牌，允许通知，点击「保存并开启提醒」。令牌只保存在应用私有存储，不允许系统备份。
3. 在网站选择「配套应用 · 精确响停节奏」，设置时长、间隔、次数和静音。
4. 把 ntfy 对应主题设为静音，保留即时投递；铃声由守望提醒应用选择和播放。
5. 保持两个应用后台运行；OPPO 的后台活动/省电设置需实机验证。停止服务后须手动重新开启，不承诺强行停止或重启后自动启动。
6. 在应用中「确认已看到」会立即停声；离线时保存待上传确认，恢复连接后同步。网页确认通过下一次同步停止，离线期间无法即时知道远端确认。

声音使用 Android 闹钟音频通道，受系统音量和勿扰设置影响。多个事件排队；一条确认或达到次数上限后处理下一条。次数耗尽仍待确认。

## 构建

需要 JDK 17 和官方 Android SDK API35、Build Tools35，无 Gradle/第三方 Android 依赖。

```bash
ANDROID_PLATFORM_JAR=/your/sdk/platforms/android-35/android.jar \
ANDROID_BUILD_TOOLS=/your/sdk/build-tools/35.0.0 \
python mobile/build.py
```

脚本生成本地开发签名密钥。密钥在 `artifacts/android/development.keystore`，不提交仓库；后续更新需保留同一签名。当前 APK 为个人验收构建，未发布应用商店。

计时测试：

```bash
mkdir -p artifacts/java-tests
javac -d artifacts/java-tests mobile/src/app/marketwatch/reminder/RingEngine.java mobile/tests/RingEngineTest.java
java -cp artifacts/java-tests RingEngineTest
```

## 真机验收表

- [ ] 配对后显示已连接，网站记录设备最后同步时间
- [ ] 指定铃声、闹钟音量、通知权限
- [ ] 15 秒响 / 停止后 30 秒再响，连续至少三轮
- [ ] 达到次数上限后停止，事件仍待确认
- [ ] 手机确认立即停止，离线确认可补传
- [ ] 网页确认后停止；重发/重启不复活已确认事件
- [ ] 静音开始中断音频，结束后恢复
- [ ] 锁屏 30–60 分钟、Wi-Fi/移动网络切换
- [ ] 服务被停止时状态真实，用户知道需要手动重新开启

依据见 ../docs/android-reminder-research.md。
