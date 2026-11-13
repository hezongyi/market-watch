# 上一交易日蓝色折线加深

分支 `feat/android-personal-v205`，基线 `1cf03709`。P0 局部样式调整：将上一交易日折线从面积配色中独立出来，浅色主题折线使用 `#4c73a5`，深色主题保持 `#7599c8`，折线不透明度从 0.72 提高到 0.92。面积渐变、参考线、红绿实时曲线和布局保持原有设置。

`npm --prefix web run build` 通过，shell `40fad3807c5e6b81`。定向实盘浏览器检查 375/412 × 深浅四组：折线配色及不透明度、面积色未变、开盘参考线未变、左右固定宽度及价格边界通过；无页面错误。NVDA/AAPL 各 389 个历史点。同步更新既有浏览器回归脚本的配色断言，本轮未重复执行完整套件。已查看[四组截图](a07-feedback/watch-blue-stroke/overview.jpg)和[前后局部对比](a07-feedback/watch-blue-stroke/comparison.jpg)，[测量记录](a07-feedback/watch-blue-stroke/proof.json)。手机最终观感待用户确认。

运行于 Ubuntu `quant-server`，原项目 `mw-android-personal-v205`，<https://192.168.7.232:18445/m/>。预检可用内存 9.4GiB、磁盘 21GiB；仅重建并替换已有 web，不增加服务。使用 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:android-personal-v205-blue-stroke --task mw-android-personal-v205 --project mw-android-personal-v205 --purpose acceptance`。固定镜像 `sha256:f8dc1232ff4ba09a8d7100b718e16fe0869ca8b6e98d786cdad7ac065118a840`，web healthy。重建后首次 readyz 短暂 502，再次使用 CA 校验及 HTTP 失败检查返回 ready，浏览器验证通过。

私有目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`；原配置保存为 `before-watch-blue-stroke-run.json`（0600），旧镜像保留。更新/启动命令：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同参数使用 `stop web`。回退（未执行）：将第一个配置换成 `before-watch-blue-stroke-run.json`，执行同样 up 命令。APK 使用“更多 → 检查更新”获取。未操作 Unraid、PR 或 CI。
