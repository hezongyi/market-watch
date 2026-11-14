# 手机图表十字线图标验收

- 分类 P0：仅手机图表顶部 SVG 图形，匹配原生绘图栏 cursor 的细线及中心留空；不更改开关行为。
- 源码提交：7af5c565。构建：受管 mw-docker / market-watch-ubuntu，TypeScript、Vite、native hooks、mobile shell 全部通过。
- Ubuntu quant-server Docker，project mw-managed-live-rollover-20261113，保留自动轮换实现。只替换 web，未重启后台和数据库，未操作 Unraid。
- 地址：https://192.168.7.232:18447/m/chart 。无本地品种选择时从数据页打开已有品种。
- Web 镜像：market-watch-web:managed-rollover-crosshair-20261114，实际 ID sha256:3615c2ab66a8438cf25bcf67ca916a6386ddcde7ad9e11b2b9f02d36d91467cf。
- HTTPS 返回 chart.294b4c21739e3a2d.js；手机页面真实加载 EURUSD。375/412px 浏览器截图确认新图标，运行时确认无文字、SVG24px、按钮38px；开关 aria-pressed true/false 均通过，服务正常。
- 浏览器截图：[375](375.png)、[412](412.png)。Android 真机未代验，APK 无需重装。
- 私有启停入口（保留原实例）：

```sh
~/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
~/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

构建需显式设置仓库根 --context 及 web/Dockerfile --file，避免安装版工具的旧默认 context。凭据、TLS、私有 Compose 与浏览器状态不入库。
