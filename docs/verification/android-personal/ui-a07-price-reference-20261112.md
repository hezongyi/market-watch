# 价格参考线蓝灰色

基线 `9fc7688a`，分支 `feat/android-personal-v205`。P0 局部样式：昨收线和历史交易日开盘线使用蓝灰色，浅色主题 `#7891ad`、深色主题 `#91a8c4`，透明度从 0.12 提高到 0.5。保持 0.8px 虚线；竖向时间参考线仍为 muted 色、0.12 透明度。价格基准值、折线、面积、列宽均未改动。

本机前端构建通过，shell `8669984829fef5ea`。浏览器回归通过（8 组布局及控件回归），已核对两种主题的昨收线/开盘线颜色、透明度及时间线优先级。[回归记录](a07-feedback/watch-price-reference/fixture-proof.json)。

Ubuntu `quant-server` / project `mw-android-personal-v205`，验收地址 <https://192.168.7.232:18445/m/>。预检约 9.3GiB 可用内存、21GiB 磁盘空间，仅替换已有 web，不新增服务，不操作 Unraid，不更新 PR、不跑 CI。

构建使用 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:android-personal-v205-price-reference --task mw-android-personal-v205 --project mw-android-personal-v205 --purpose acceptance`。私有目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`，更新前备份 `before-watch-price-reference-run.json`，0600，旧镜像保留。

启动/更新：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同参数后使用 `stop web`。回退（未执行）：第一个配置改为同目录 `before-watch-price-reference-run.json`，运行同样 up 命令。APK 通过“更多 → 检查更新”获取更新，最终观感待手机验收。

已更新固定 web 镜像 `sha256:a8cc1b36804ee8f70763d506aa04703a0e47bcc7ffc9141b28a0d52b1af9e759`。CA 验证 `/readyz` 正常、web healthy。实盘四组布局均检查开盘线蓝灰色及 0.5 透明度、原有图宽和列宽；无页面错误。[实盘测量](a07-feedback/watch-price-reference/proof.json)、[前后对比](a07-feedback/watch-price-reference/comparison.jpg)、[深色](a07-feedback/watch-price-reference/dark-412.png) 已查看。截图行情时间不同，价格和曲线变化不作为样式比较依据。
