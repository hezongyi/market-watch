# 上一交易日 sparkline 蓝色系

分支 `feat/android-personal-v205`，基线 `6bd2a007`。P0 局部样式补丁：当日无数据时显示的上一交易日曲线由灰色改为低饱和蓝色；浅色主题 `#6488b8`，深色主题 `#83a6d4`，面积渐变继承折线蓝色。保留原线条透明度和面积透明度、开盘价参考线及无日期小字的布局；当天到数后继续使用原涨跌配色。没有修改数据读取逻辑。

前端 `npm --prefix web run build` 通过，shell `48f3a8c036df102e`。既有浏览器回归已通过，覆盖 8 组布局及深浅主题的上一日折线/面积同色检查，另确认当天到数后恢复涨跌配色。[浏览器测量](a07-feedback/watch-session-blue/fixture-proof.json)。实盘 NVDA、AAPL 返回上一交易日各 389 个真实点；375/412 × 深浅四组均验证蓝色及原开盘线、72px 行高、42px 图高、无日期小字和无页面错误。[实盘测量](a07-feedback/watch-session-blue/proof.json)、[浅色截图](a07-feedback/watch-session-blue/light-375.png)、[深色截图](a07-feedback/watch-session-blue/dark-412.png) 已人工查看。

运行主机 Ubuntu `quant-server`，地址 <https://192.168.7.232:18445/m/>。资源预检可用内存约 9.4GiB、磁盘 22GiB，复用 project `mw-android-personal-v205`，仅替换 web，不新增服务。API、worker、数据库和自选保持；无 Unraid 操作，无 PR 更新及 CI。

通过 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:android-personal-v205-session-blue --task mw-android-personal-v205 --project mw-android-personal-v205 --purpose acceptance` 构建。固定运行镜像 `sha256:7721459104202da45616519a8a2651c4f349ceb4b8a395477c4c2fc90f32a82a`，旧镜像保留。私有配置目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`，0600 备份 `before-watch-session-blue-run.json`；不提交私有配置及凭据。

启动/更新（已执行）：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止 web（留档，未执行）：同样 compose 参数后使用 `stop web`。回退（未执行）：第一个配置文件替换为同目录 `before-watch-session-blue-run.json`，执行同样 up 命令。CA 校验 `/readyz` 正常、web healthy；APK 经“更多 → 检查更新”获取网页资源。真机最终观感待用户验收。
