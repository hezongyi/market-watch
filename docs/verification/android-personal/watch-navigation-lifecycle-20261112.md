# 自选行情连接与前后台生命周期

分支 `feat/android-personal-v205`。P0 局部前端生命周期调整，无 API、数据库或持久格式变化。自选页离开导航时保留最后视口内品种的报价订阅，仍共用应用唯一 SSE；隐藏期间自选增删会剔除已经移除的品种。断开的 IntersectionObserver 回调不能再清空保留的品种。进入后台仍按现有逻辑关闭 SSE、取消报价与历史请求；回前台自动重连并重新读取报价，在自选页可见时也刷新 sparkline 历史。隐藏自选页不轮询历史，返回自选后恢复。

同时部署上一轮已获用户确认的展示变更：72px 行高保留，sparkline 容器由 42px 增至 50px，SVG 坐标统一到 50；M1 原始数据保留，绘制层按窗口时间对齐的 5 分钟桶取末点，保留最新点及缺口，纵向范围按绘制数据计算。

验证：前端生产构建、`node tests/mobile-transport.cjs`、`node tests/mobile-sparklines.cjs`、`node tests/mobile-watch.browser.cjs`、`node tests/mobile-watch-a07.browser.cjs` 和 `git diff --check` 通过。新增浏览器回归检查切换更多/数据仍保留原 SSE、隐藏时仍接收流式报价、后台零订阅/零请求、前台补取最新报价、返回时补取历史及单一共享连接。浏览器 API 替身验证不等同于实机验收。

Ubuntu 本机 `quant-server`，既有隔离 project `mw-android-personal-v205`，地址 <https://192.168.7.232:18445/m/>。预检内存可用约 8GiB，磁盘可用约 19GiB；仅重建并更新 web，无 API/数据库变更。使用 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:android-personal-v205-watch-lifecycle --task mw-android-personal-v205 --project mw-android-personal-v205 --purpose acceptance` 构建。固定镜像 `sha256:58d40552f545a52ad0a5496ebb279a29d0d273d7e1c4ba19728a40319abc691a`，shell `7eea96aa83c515bb`。HTTPS CA 校验 `/readyz` 返回 ready，新 shell 已提供。未操作 Unraid、PR 或 CI。

私有目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`。旧配置保存为 `before-watch-lifecycle-run.json`（0600），旧镜像保留。更新/启动：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同参数使用 `stop web`。回退（未执行）：第一个配置文件换成同目录的 `before-watch-lifecycle-run.json`，再执行相同 up 命令。

实盘浏览器检查同一 SSE 跨更多/数据/自选保留、在更多页进入后台后 SSE 关闭且无新增报价/历史请求、回前台新连接打开并补取报价、返回自选补取历史，以及停留自选时前后台恢复。7 行实盘布局均为 72px 行高与 50px 图高；无页面错误。验证脚本模拟 `document.hidden`，Android 实机切 App 和系统调度仍待用户确认。实盘检查记录与截图见 `a07-feedback/watch-lifecycle/`。现有 APK 可在“更多 → 检查更新”取得新网页壳。
