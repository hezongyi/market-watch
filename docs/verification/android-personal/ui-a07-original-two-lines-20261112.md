# 三行初版保留首尾两行

用户最新要求：以第一版三行样式为依据，仅删除中间品种名称行，保留代码及“行情种类 · 供应商源”。此决策取代此前缩小灰字和紧凑次行的方案。P0 局部显示调整；不提交、不更新 PR、不跑 CI。

恢复原代码 15px / 650、行高 1.45；来源行 12px / 常规、统一原 muted 灰色、上边距 2px。整条来源为一个文本节点，使用原 Binance / Yahoo 等展示名，不分配两种字号、不做单独来源弱化。完整描述及来源保留 title。只删除列表中的名称行，管理弹层仍显示名称。保留右侧价格、sparkline、行高和大字号布局行为。

验证：TypeScript / Vite / shell 构建通过；A07 8 组布局、弹层、离线、空态检查通过。已有失败刷新检查改为逐行检查缓存图或错误空态，避免空响应与本机快照读取时序造成错误预期，不改产品缓存逻辑。实际行情 375/412 × 深浅四组通过，核实来源字号、代码字重、间距、无名称行、来源内容及原曲线/价格属性，无 pageerror。人工查看实际浅色 412 和本地深浅截图；真机视觉验收待用户完成。证据见 [original-two-lines/proof.json](a07-feedback/original-two-lines/proof.json) 及同目录截图。

Ubuntu quant-server / 192.168.7.232，本机 Docker project `mw-android-personal-v205`，<https://192.168.7.232:18445/m/>。磁盘可用 29GiB、内存可用约 10GiB；复用原 5 服务，仅更新 web。

- 网页 build：`339a92daa4fcad07`；HTTPS CA 验证 readyz / manifest 均 200。
- 新 web：`sha256:9a1afa76c1aa95659ac5a948a282844c780023e42d601170e5f0c72efea64760`。
- 旧 web：`sha256:012421a4acd13a3322f8b90a274d4a3d37d58a4db0da25bbf4b0a60542d7b275`；私有旧配置 `before-original-two-lines-run.json`。
- 构建由 mw-docker 标记 task / project / acceptance 并检查标签归属。APK 保持 0.1.3，更多 → 检查更新刷新网页。

启动：

```bash
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --wait
```

停止使用相同前缀与配置，将末行改为 `stop`。本次仅执行 `up -d --no-build --pull never --no-deps --wait web`；无 API / 数据库 / Unraid 修改。
