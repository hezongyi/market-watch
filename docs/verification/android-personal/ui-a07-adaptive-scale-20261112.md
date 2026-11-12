# 自选页 sparkline 自适应纵轴

分支 `feat/android-personal-v205`。P0 前端展示调整：纵轴改用各行实际最低价与最高价，并按品种类别设置最低总显示范围：外汇 0.20%、贵金属 0.50%、股票/其他 1.00%、主流加密货币 2.00%。范围带上下各 10% 留白；实际波幅更大时继续扩展。参考价映射到同一坐标，不固定在中线。参考价落在数据范围之外时显示在最近边缘、增强虚线并在 SVG 无障碍说明中注明，不用昨收/开盘价拉平盘中数据。时间坐标、采样数据和面积样式未变。

验证：`node web/tests/mobile-sparklines.cjs` 通过；`node web/tests/mobile-watch-a07.browser.cjs` 通过，无页面错误；前端生产构建通过。Ubuntu `quant-server` 上 `mw-android-personal-v205` 原验收实例更新完成，`/readyz` 返回 ready。定向实盘浏览器检查 375/412 × 深浅主题四组通过，实际 NVDA/AAPL 各有 389 个上一交易日点；两行曲线纵向跨度均超过 5 SVG 单位，参考价会依走势变动，不再固定居中。AAPL 本次开盘参考价位于曲线范围下方，贴边显示并标记。截图见 [总览](a07-feedback/watch-adaptive-scale/overview.jpg)、[浅色 375](a07-feedback/watch-adaptive-scale/light-375.png)、[深色 375](a07-feedback/watch-adaptive-scale/dark-375.png) 和 [检查记录](a07-feedback/watch-adaptive-scale/proof.json)。手机最终观感待用户验收。

运行 URL：<https://192.168.7.232:18445/m/>。验收镜像 `sha256:83af7150fecab89b62697222d36387f6785b2cc17dc91fb0320d2585f07d42a3`。私有配置位于 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`；部署前配置副本为 `before-watch-adaptive-scale-run.json`（0600），旧镜像保留。更新/启动：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

回退（未执行）：使用同一命令，将第一个配置文件改为 `before-watch-adaptive-scale-run.json`。未操作 Unraid、PR 或 CI。
