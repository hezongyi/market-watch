# A07 Sparkline 参考图优化

## 最新反馈：恢复原色，单独减淡折线

用户要求恢复此前配色、保留面积色，并认为折线颜色太深。当前已恢复全局原有涨跌色用于自选折线及涨跌文字，折线独立设置 `strokeOpacity=.72`。面积填充通过独立色标保留上一轮青绿/珊瑚红和原有渐变透明度；没有把整个 SVG 一起淡化。stale/缓存仍使用灰色。RDP、线宽、布局不变。

当前网页 build `af1db51660232e10`，web 镜像 `sha256:bd96ee8e20cc3ae93e253f8699426d2c27beb5104adb4a80d4db2691ee913dc1`。前轮镜像见下文。APK 仍为 0.1.3，通过更多 → 检查更新刷新网页。Ubuntu `quant-server` 的原验收地址与下文启动/停止命令不变；仅替换任务 web，资源检查磁盘 32 GiB、内存 5.7 GiB 可用。无 PR、CI、APK 打包或 Unraid 修改。

Docker 内 TypeScript/Vite/mobile shell 构建通过；HTTPS 任务 CA 验证 readyz 200 和新 build。真实行情 375/412 × 深浅主题四组检查通过：原折线/文字颜色、面积颜色保留、独立 72% 不透明度、灰色状态、渐变 ID 和布局均正常，无 pageerror。截图与测量见 [证据](a07-feedback/sparkline-opacity/proof.json)。真机观感待用户复验。

## 前轮反馈：密集折线与配色

用户反馈第一版仍有挤压感，并要求优化配色。第一版按像素列保留高低点，150–175px 图幅仍保留约 280–340 个折点；对每个像素列的极值追踪使细碎波动依然明显。现已改为逐连续段的屏幕坐标 RDP 简化，容差 0.7 SVG 单位，强制保留段首尾与段内最高/最低点。所有输出点仍来自原始观察值，细小局部波动会被省略；不宣称保留每一个局部极值。固定时间坐标、未来空白和数据缺口保留。外汇新日界只占左侧的现象属于窗口语义，本次不拉伸。

自选页局部颜色改为青绿/珊瑚红，保持绿涨红跌。浅色曲线 `#238779` / `#cf6c65`，涨跌文字 `#187264` / `#b24f49`；相对 `#f8f9fc` 的对比度分别约 4.14 / 3.33、5.50 / 4.86。深色曲线与文字 `#65b6a4` / `#e39b94`，相对 `#101317` 对比度约 7.79 / 8.32。原有缓存和 stale 灰色覆盖保留；其他页面不改配色。

验证：构建、sparklines 语义测试通过，新增简化误差上限（含坐标舍入）、亚像素噪声样本；原尖峰/低谷/断档/首尾保留检查继续通过。A07 的 8 组布局与离线/更新桥回归通过。真实行情深浅 × 375/412 四组通过，无 pageerror、文字重叠或渐变 ID 冲突。当前 BTC/ETH 渲染约 185–209 个点，截图与详情见 [本次证据](a07-feedback/sparkline-soft/proof.json)。原生真机效果待用户复验。

当前网页 build：`3424f0f991120d8e`，APK 保持 0.1.3；Ubuntu 原验收地址 <https://192.168.7.232:18445/m/>，更多 → 检查更新刷新网页。新 web 镜像 `sha256:7d665005f7222200ad49050834aae1b5779bc59d989d704e75eb4c2e4a3762d3`，前一镜像为下文第一版交付。构建前磁盘可用 32 GiB、内存 5.8 GiB；复用现有五服务，只替换 web。使用下文同一启动/停止入口和任务专用构建入口。任务 CA 验证 readyz、manifest 200，新 build 匹配。无 PR/CI、APK 重打包或 Unraid 修改。

## 第一版记录

用户认可同花顺截图对照分析并授权执行。本轮仅更新自选页绘制，不改后端原始数据、交易时段、涨跌配色或 APK。分类 P0：局部渲染逻辑与样式，针对显示点简化增加必要语义检查。PR、提交、CI 继续按用户要求暂缓。

## 实现

- SVG 纵向渐变：浅色 22% → 8% → 0%，深色 18% → 6% → 0%，中间色标 55%；同一小图所有分段使用同一坐标系。每个 Spark 通过 React useId 隔离渐变引用，缓存/过期颜色沿用现有规则。
- 折线 1.4 → 1.2 CSS px，圆角连接与端点；去掉额外终点圆点。单观察值用零长度圆帽线段保持可见。
- ResizeObserver 获取小图实际 CSS 宽度。每个连续段按像素列保留高低点及首尾点，按原时间顺序绘制，减少亚像素折线重叠。不平均价格、不补缺口、不拉伸未来空白；后端原始点与缓存均保留。
- 默认代码列 6.7 → 6.2rem，列间距 10 → 8px；价格列与长代码专属宽度保留。常规宽度给小图增加约 11px；大字号继续沿用独立第二行布局。
- 竖向参考线透明度从 20% 降至 12%。不添加没有数据依据的昨收线。

## 验证

- TypeScript、Vite、mobile shell 构建通过；`git diff --check` 通过。
- `node tests/mobile-sparklines.cjs`：既有加载/取消/日界/缺口检查通过；新增 1440 点密集样本，验证同一像素列内的相邻尖峰与低谷保留、时序单调、两段缺口、端点和未来空白、单点可见。
- `mobile-watch-a07.browser.cjs`：8 组深浅主题、375/412、150% 字号和横屏布局，以及弹层/空态/离线/更新桥通过。
- `mobile-watch.browser.cjs`：订阅、SSE、滚动恢复、分组/搜索行为通过。
- Ubuntu 真实行情：375/412 × 深浅主题四组截图通过。渐变 ID 唯一且引用可解析；实际图宽与 SVG 坐标宽一致；代码/价格文字不碰撞小图；常规行高 94px；无 pageerror。
- 真实分组已由用户扩充到 6 项，首次 smoke 的固定 5 项断言失效。检查改为保留用户分组并验证已知品种包含关系，没有重置分组或数据库。
- 切换主题经过更多页返回时存在原有短暂订阅重建/灰色状态；最终截图等待 SSE 与报价对齐后采集，不把暂态当作最终配色。
- 原生真机观感仍待用户验收。截图与测量见 [证据目录](a07-feedback/sparkline-refinement/proof.json)。

## 交付与运行

Ubuntu 本机 `quant-server` / `192.168.7.232`，独立 Compose project `mw-android-personal-v205`。开始时磁盘可用 33 GiB、内存可用约 5.7 GiB。本次只替换现有 web 服务，不新增服务/端口，不改 Unraid。

- 验收地址：<https://192.168.7.232:18445/m/>。
- 网页 build：`5d9ba148909c88e3`；APK 保持 0.1.3，通过更多 → 检查更新刷新网页。
- 新 web 镜像：`sha256:a0fcef6454d9125b792bf3cbfd42370dc0cf2ca5affaecef3334d3633563005a`。
- 上轮镜像：`sha256:a52ca304243a4d648280351c9b3cd7ab97a8ed07f36f357ac375589c630b5378`。
- `mw-docker build` 显式指定任务/project/acceptance；检查镜像任务标签后仅更新私有 run.json 的 web image ID。
- HTTPS 以任务 CA 校验证书链：readyz 200、shell manifest 新 build、更新清单仍为 APK 0.1.3。

启动命令（停止使用相同前缀与两个配置文件，将末行换为 `stop`）：

```bash
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --wait
```

本次更新用上述前缀执行 `up -d --no-build --pull never --no-deps --wait web`。不使用原离线 preview helper。
