# Android 0.1.1 用户自验候选

2026-11-11；当前是开发签名候选，目标尚未完成。无需先连接 ADB；用户自行安装并记录 Find X8 结果即可。遇到难复现问题，再接 ADB 定位。

## 安装与连接

- 本机 APK：`.artifacts/android-personal-v205/market-watch-0.1.1-debug.apk`。
- 局域网下载：<https://192.168.7.232:18445/downloads/market-watch-0.1.1-debug.apk>。这是本任务开发证书，手机浏览器不一定已信任；也可从 Ubuntu 将本机 APK 传给手机安装。APK 内的 Debug 信任仅针对该 IP 的本任务 CA，不绕过证书错误。
- 首次输入 **`https://192.168.7.232:18445`**。18443 是已有 mw-dev，未修改。
- 登录信息在本机 `.artifacts/android-personal-v205/login.txt`（0600，未提交），只含本任务连接地址和登录密码。不要上传该文件。完整任务私有配置位于 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`。
- `applicationId=com.kookvv.marketwatch`，versionCode=2，versionName=0.1.1。
- SHA-256：`81d1bcc980697e9cf01a328b969adc4a9a4096dc8a7ec55e422e4f15acd4066e`。
- APK 签名证书 SHA-256：`ca8ee3bd68d2aa412119ea53b15f5393b3a2a9e57aea30f68f2e25b450e9fd33`。与 0.1.0 相同；可试覆盖安装，实际设备结果待记录。
- 候选源树：`0b8ea9e7884f902c34e155072ef3c560a968a0d7`；应用修复提交 `7457020a`；固定应用基线 `1bb935bdf1195c4da532cb2e6f62faca2198e6c4`。APK 二进制、许可库、私钥和凭据均不提交。

## 当前能验证的范围

实际 Ubuntu Docker，task/project 均为 `mw-android-personal-v205`，独立 PostgreSQL14.24/API/Web/TLS、网络、volume 和凭据；未使用 Unraid。实例禁供应商出网，未配置 ntfy，未启动完整告警执行与通知 worker 链路。自选中的 D1_BTCUSDT/D1_EURUSD 是**固定旧日期的合成测试缓存**，分组标明“D1 合成数据 · 非实时”。这些用于实际 widget 和设备交互检查，不能作真实报价或告警执行证明。数据目录未补齐平台/历史/组合样本，创建告警需要组合，当前这两个旧 managed 样本不能用于新建告警。

已通过完整构建、共享桌面 unit、手机缓存迁移/退出/迟到写入、告警/自选 HTTP doubles 浏览器、实际许可 widget 生命周期、Android assemble/lint 和签名校验。独立 Standards/Spec 审查的问题已关闭，见 [审查记录](review.md)。[真实后端 smoke](real-backend-r1.json) 已核验真实 HTTPS 登录/CSRF、自选、实际缓存柱、真实服务器指标目录/原生选择器、返回和退出；Chromium 接受开发证书，Python SSL 另用本任务 CA 验证链。均不是 Find X8 证据。

## Find X8 自验记录

记录 Android/ColorOS/WebView 版本及此 APK hash，然后依次检查：

1. 安装/覆盖安装、输入地址、登录；退出重开后是否能正常回到对应页面。
2. 点 D1 自选打开真实图表，拖动/缩放/触屏十字线；指标选择、添加副图、修改参数、取消参数修改。
3. 切换页面、旋转、系统返回和键盘收起；返回是否先关闭最上层窗口，未提交输入是否保留。
4. 杀进程重开后，图表品种/周期/指标参数、主题、自选分组/滚动是否恢复。
5. 断网重开应只读缓存；连回后核验会话再加载；退出后不能恢复旧账号内容。此固定旧数据集不能证明实时 SSE 行情新鲜度。
6. 在“换服务器”中输入不可达 HTTPS 地址或错误端口，应可重试或返回连接设置；证书错误不得继续加载。

反馈可按“项目｜通过/失败｜实际现象”记录。真实供应商、组合告警从接管到执行、ntfy 手机实收和完整覆盖升级另验；不要用页面创建成功或 worker 健康代替实收。

## 实例操作

在实现树执行：

```sh
python3 deploy/ubuntu/mw_docker.py preview status --task mw-android-personal-v205 --project mw-android-personal-v205
python3 deploy/ubuntu/mw_docker.py preview up --task mw-android-personal-v205 --project mw-android-personal-v205
python3 deploy/ubuntu/mw_docker.py preview stop --task mw-android-personal-v205 --project mw-android-personal-v205
```

保留当前 volume 和私有配置，不执行 reset、retire 或全局清理。开发 CA 有效至 2026-12-11 07:05:42 UTC；Release 不含该 CA，私有发行签名尚未配置。没有合并、正式 tag、生产发布或生产资源操作。
