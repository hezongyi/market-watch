# 0.1.1 下载校验

Python 标准 SSL 使用本任务 `.tools/dev-tls/ca.pem` 验证 `https://192.168.7.232:18445` 证书链后读取：

- `/readyz`：200，application/json。
- `/m/`：200，708 bytes，text/html。
- `/m/shell-manifest.json`：200，壳版本 `336b1019fb404a53`。
- `/downloads/market-watch-0.1.1-debug.apk`：200，2300179 bytes，application/octet-stream，SHA-256 `81d1bcc980697e9cf01a328b969adc4a9a4096dc8a7ec55e422e4f15acd4066e`，与本地签名验证 APK 相同。

下载目录为本任务 `web/vendor/downloads/` 的未跟踪产物，经 Vite publicDir 放入验收镜像；未提交 APK。构建/部署均通过任务专用 mw-docker 入口，镜像和 PG 版本见 [部署记录](deployment-0.1.1.json)。
