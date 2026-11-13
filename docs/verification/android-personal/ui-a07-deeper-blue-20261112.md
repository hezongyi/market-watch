# 上一交易日蓝色稍加深

分支 `feat/android-personal-v205`，基线 `de2f567b`。P0 两个配色 token 调整：上一交易日 sparkline 浅色主题由 `#6488b8` 改为 `#587dab`，深色主题由 `#83a6d4` 改为 `#7599c8`。折线和面积共用该色，维持原透明度，形成略深一档的低饱和蓝色。价格参考线、当天涨跌色、图宽及数据读取不变。

前端构建通过，shell `b4fafd2ec7af5999`。本轮采用构建和定向实盘浏览器验收，不重复跑与两处颜色无关的后端回归；同步更新已有全页浏览器脚本的颜色期望。

Ubuntu 主机 `quant-server`，project `mw-android-personal-v205`，地址 <https://192.168.7.232:18445/m/>。资源预检可用内存约 9.8GiB、磁盘 21GiB；仅更新原 web 服务。通过 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:android-personal-v205-deeper-blue --task mw-android-personal-v205 --project mw-android-personal-v205 --purpose acceptance` 构建，不操作 Unraid、不更新 PR、不跑 CI。

私有目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`。修改前保存 `before-watch-deeper-blue-run.json`（0600），旧镜像保留。更新/启动：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同参数使用 `stop web`。回退（未执行）：第一个配置改为同目录 `before-watch-deeper-blue-run.json`，运行同样 up 命令。APK 通过“更多 → 检查更新”取得更新，最终手机观感待用户验收。

已更新固定 web 镜像 `sha256:c91ec1c3271a780dd8e1df7f4588c4b599527cd3482dac9796b6c94bda584773`；CA 校验 `/readyz` 正常、web healthy。实盘 375/412 × 深浅四组检查折线/面积色、开盘线及布局通过，无页面错误。NVDA/AAPL 各返回 389 个实际历史点，未改变数据。四组截图已查看：[前后局部对比](a07-feedback/watch-deeper-blue/comparison.jpg)、[浅色](a07-feedback/watch-deeper-blue/light-375.png)、[深色](a07-feedback/watch-deeper-blue/dark-412.png)、[测量记录](a07-feedback/watch-deeper-blue/proof.json)。
