# 自选左侧品种信息与小图对齐

用户认可右列宽度及显示，本轮仅优化左侧。分类 P0：局部 JSX、样式与对应布局断言，无接口、数据或原生变更。按用户要求不提交、不更新 PR、不跑 CI。

## 结果

- 原左侧代码、名称、来源三行约 64px，与 42px 小图居中，但视觉高度未统一。现为两行：代码主信息；名称与简短来源共用次行，用细分隔线区分。
- 代码字重 600，来源弱化；Binance 简写币安，Yahoo Finance 简写 Yahoo，保留自建/组合身份。完整名称及来源保留 title / aria-label。窄屏长名称和来源省略，不挤入曲线区。
- 默认字号左侧信息区和小图均 42px，垂直中心对齐；大字号仍允许增高并将小图移至下一行，不强制裁切文字。
- 右侧价格列、94px 常规行高、曲线/面积色、昨收线及缩放逻辑均保持本轮修改前行为。

## 验证与边界

- TypeScript/Vite/mobile shell 构建通过。
- A07 浏览器 8 组尺寸/字号/主题及弹层、离线、空态检查通过；加入左右信息与图表中心、正常字号高度、大字号上下不碰撞断言。
- Ubuntu 真实行情 375/412 × 深浅主题四组通过：所有 6 行包含空图状态均 42px 对齐；无页面异常、横向溢出及代码/价格与曲线碰撞；右侧显示与已有图形属性检查通过。人工查看浅色窄屏与深色截图。
- 实测跨 UTC 00:00：原测试要求至少 5 个有曲线及昨收的品种，因新日样本尚未到达失败。检查改为全部行布局（含真实空图），以及有曲线行的参考线位置。随后 BTC/ETH 新日数据到达，已有 EURUSD/XAUUSD 昨收线正常；GC=F/QQQ 暂无日内数据。未修改数据或伪造曲线满足测试。
- 证据：[实际行情结果](a07-feedback/identity/proof.json)、[布局结果](a07-feedback/identity/layout-proof.json)、同目录截图。真机视觉验收仍待用户完成。

## 运行与交付

- Ubuntu quant-server / 192.168.7.232，本机 Docker project `mw-android-personal-v205`，地址 <https://192.168.7.232:18445/m/>。
- 资源检查：磁盘约 30 GiB、内存约 5.9 GiB 可用；复用原五服务，仅更新 web，无数据重置或 Unraid 修改。
- 网页 build `89af229340106c5c`，HTTPS CA 校验 readyz / manifest 均 200。
- web `sha256:7ba79d0208bae282d12e77b994ccb24d0e5291e0087f28df3b5d04e3501ac4ff`，由带 task/project/acceptance 标签的 mw-docker 构建。
- 旧 web `sha256:17e651baa58ad7e5180d59a60449c63b34f53e65923cceed196cbecfa711bed6`；私有旧配置 `before-identity-layout-run.json` 保留于任务私有目录。
- APK 仍为 0.1.3；更多 → 检查更新刷新网页，无需重装。

启动命令：

```bash
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --wait
```

停止使用相同前缀与两个配置文件，将末行改为 `stop`。本次仅执行 `up -d --no-build --pull never --no-deps --wait web`，未重启其他服务。
