# 自选左侧代码、行情种类与供应商源

用户确认方案 A 后要求实现并收紧行距、缩小灰色次要信息。分类 P0：局部文字组织和样式，无 API / schema / 原生改动。按用户要求不提交、更新 PR 或跑 CI。

- 主行代码 15px / 600，行高 1.35；次行“平台 / 自建 / 组合 · 供应商源”，其中种类 10.5px / 500，来源 10px / 常规，灰色。主次行间距 2px，次行行高 1.25。
- 种类取已有系列身份，来源取既有描述中的来源字段或 exchange。Binance / Binance Spot 显示币安，Yahoo Finance 显示 Yahoo。自建、组合也保留来源，不再仅显示种类。未知来源明确显示来源待确认，不伪造供应商。
- 名称不再占用左侧常驻空间，原完整描述仍保留在行 title。供应商超宽使用省略，完整来源保留标题和无障碍标签。
- 保留左侧 42px 区域与小图居中、94px 常规行高、右侧价格列及全部曲线行为。

验证：TypeScript / Vite / shell 构建通过；A07 8 组尺寸/主题/字号、弹层、离线缓存、空态检查通过；A06 布局脚本通过。A07 原“失败后空图”断言与已有有效缓存行为冲突，改为要求全部 6 行保留标记为缓存的图形，不修改产品逻辑。增加种类和来源内容断言。Ubuntu 实际行情 375/412 × 深浅四组通过，检查种类、来源、10px 来源字号、2px 间距、42px 对齐、曲线样式及价格精度，无 pageerror。实际浅色 375 截图已人工查看。证据见 [kind-source/proof.json](a07-feedback/kind-source/proof.json) 与同目录截图；真机视觉验收待用户完成。

运行主机为 Ubuntu quant-server / 192.168.7.232，本机 Docker project `mw-android-personal-v205`；地址 <https://192.168.7.232:18445/m/>。部署前磁盘可用 29GiB，内存可用约 9.9GiB，复用原 5 服务，仅替换 web，无数据重置。APK 仍为 0.1.3，通过更多 → 检查更新刷新网页。

- 网页 build：`46ce9d35ffc40644`，HTTPS CA 验证 readyz / manifest 200。
- 新 web 镜像：`sha256:012421a4acd13a3322f8b90a274d4a3d37d58a4db0da25bbf4b0a60542d7b275`。
- 旧 web：`sha256:7ba79d0208bae282d12e77b994ccb24d0e5291e0087f28df3b5d04e3501ac4ff`；私有旧配置为 `before-kind-source-run.json`。
- `mw-docker build` 显式提供 task / project / acceptance 标签并检查归属。前端采用已 rebase 至 v2.0.7 的工作树；本次没有替换后端镜像。

启动：

```bash
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --wait
```

停止用相同前缀和配置文件，将末行改为 `stop`。本次仅执行 `up -d --no-build --pull never --no-deps --wait web`。
