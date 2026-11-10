# 静态资源 gzip 验证（2026-11-10）

风险分类 F0：仅改变前端静态 HTTP 传输编码，不改变应用内容、数据格式或数据库。采用 Ubuntu Docker 静态代理 R1 smoke、实际开发实例 HTTP 对照与真实浏览器登录；不需要数据库副本。

## 配置与隔离

- `web/nginx.conf`：静态资源与公共 SPA 入口启用 gzip；API/MCP/健康检查路径继续使用未启用 gzip 的配置。
- `deploy/ubuntu/development-vite.conf`：前端资源 gzip，API/MCP 路径排除；原有 WebSocket、无缓冲代理与读取超时设置保留。
- gzip level 5，最小 1024 bytes，`Vary: Accept-Encoding`；不压缩 PNG/JPEG 或 JSON/SSE。
- Ubuntu `quant-server` 上独立 project `mw-compression-20261110`，单个 Nginx 容器（128 MiB / 0.25 CPU），回环端口 19656/19657，无数据库。测试完成后停止。
- 候选同时加载两份配置；测试副本只将开发端口改为8080并移除重复的全局 resolver。上游用本容器的5173/8000模拟；API故意返回大于1024 bytes的HTML，验证路由排除确实生效。

## 结果

基线：开发实例同一脚本携带 `Accept-Encoding: gzip` 仍返回1043265 bytes，未设置 Content-Encoding。

独立 HTTP smoke：两份配置均通过语法检查；JS/CSS/HTML返回gzip并可解压还原完全相同内容；API/MCP、大图像、小脚本、`gzip;q=0`不压缩。未新增仅检查配置文本的单元测试。

开发实例部署：cherry-pick配置提交，更新只读绑定配置后重建 `web` 代理容器。首次热加载仍读取旧绑定文件的inode，HTTP断言准确捕获未生效，重建代理后通过；未重启API、数据库或前端进程。

开发真实HTTPS端点的三种协商（identity/gzip/gzip;q=0）全部验证通过，解压后SHA256完全一致，缓存策略不变；详见 `http-results.json`。

- 图表适配器：1043265 → 312133 bytes，减少70.1%。
- 原生核心：2666702 → 699010 bytes，减少73.8%。
- 以上仅为两个主要脚本，动态gzip分块导致编码字节数可有小幅变化。

Playwriter会话13真实密码登录（禁用浏览器缓存）：工具栏4993ms就绪，观察超过25秒无恢复提示、无Value is null或pageerror；初始未登录的/api/session 401为预期。浏览器记录适配脚本encodedBodySize312124、decodedBodySize1043265。Vite WebSocket连接正常。登录后的/api/session为200且无Content-Encoding。

另通过登录会话读取通知分页基线并连接 `/api/notification-center/stream`：200、text/event-stream、无Content-Encoding、立即收到13-byte心跳，随后取消。真实浏览器页与自有会话已关闭。

私有浏览器与部署证据保存在 `~/.local/share/market-watch-dev/evidence/`、`updates/static-compression-20261110/`，不提交凭据、完整浏览器状态或许可脚本。

开发访问：https://192.168.7.232:18443/ 。启停沿用 `mw-dev up` / `mw-dev stop`；仅需重启代理用 `mw-dev restart web`。本轮只更新开发实例，正式构建配置随代码纳入后续发布。

此改动减少传输量；25秒失败提示逻辑未改变，不保证所有慢网下都不触发。浏览器单次5秒测量不构成网络条件一致的前后性能对照。
