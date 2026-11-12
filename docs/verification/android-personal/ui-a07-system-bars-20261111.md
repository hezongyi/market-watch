# A07 系统栏颜色与提示移除 · APK 0.1.3

用户截图 `Screenshot_2026-11-12-06-40-11-21_bf9c6e545ee4bfd4340a0323cc28c9fd.jpg` 从 Unraid Studio 根目录只读取得。浅色网页上下的暗色区域来自原生安全区容器：背景与系统图标没有跟随网页主题。

本次通过仅可信主框架可调用的 `appearance-v1` 消息同步 light/dark 枚举。原生容器、窗口与 WebView 初始背景统一使用浅色 `#f8f9fc` / 深色 `#101317`，透明系统栏的图标亮暗随之切换；保存上次原生主题。安全区尺寸和键盘避让保持原逻辑，连接设置文字也保持对应对比度。自选页移除“固定日界线 · 未到的时间留白”及专属样式，行情窗口与留白算法保持原逻辑。

F0：兼容的原生主题桥扩展，无后端改动。用户要求继续暂缓 PR、提交及 CI。

## 本地验证

- Android `testDebugUnitTest assembleDebug lintDebug --offline` 成功；4 项现有 JVM 测试通过，lint 0 errors / 19 warnings（包括新增的 KTX 写法建议，无 baseline）。
- TypeScript / Vite / mobile shell 构建成功。
- `mobile-watch-a07.browser.cjs` 通过：8 组布局、状态与更新入口，以及新增的真实主题按钮 dark → light → dark 桥接检查；无 pageerror。截图与 proof 留在 `/tmp/mw-a07-system-bars/`。
- APK 与 0.1.2 签名一致，证书 SHA-256 为 `ca8ee3bd68d2aa412119ea53b15f5393b3a2a9e57aea30f68f2e25b450e9fd33`。
- HTTPS 按任务 CA 校验证书链：readyz 200、更新清单 no-store、下载长度和 SHA-256 匹配构建产物、已部署 bundle 包含主题桥且不含被删除提示。见 [交付证据](a07-feedback/system-bars-delivery.json)。
- ADB 无连接设备，尚未验证 ColorOS 实际系统栏、原生下载/安装流程。

## 当前验收交付

Ubuntu `quant-server` / `192.168.7.232` 的独立 Docker project `mw-android-personal-v205`。构建前磁盘可用 33 GiB，内存可用约 5.5 GiB；本次仅替换该任务 web 容器，复用现有五服务，不增加端口或数据库。Unraid 无修改。

- 地址：<https://192.168.7.232:18445/m/>，网页构建 `d7debd87935256f3`。
- APK：0.1.3 / versionCode 4，<https://192.168.7.232:18445/downloads/market-watch-0.1.3-debug.apk>。
- 已安装 0.1.2 可从“更多 → 检查更新”覆盖安装；真实安装确认仍由用户完成。
- 新 web 镜像：`sha256:a52ca304243a4d648280351c9b3cd7ab97a8ed07f36f357ac375589c630b5378`。
- 前一 web 镜像：`sha256:845ae98d5b61c011644364475a8ca0cf87facc7605a2343b4cdb446567494874`。

启动/停止沿用 [前轮记录](ui-a07-feedback-20261111.md) 的私有 `run.json` + `live-data.override.json` Compose 入口；本次仅更新 run.json 的 web 镜像 ID，通过同一前缀执行 `up -d --no-build --pull never --no-deps --wait web`。不使用通用 offline preview helper。

手机验收：安装后浅色上下安全区与页面衔接，状态栏文字/底部手势条清晰；切换深色再切回、重启 App、打开键盘后仍正确；自选页底部提示消失。
