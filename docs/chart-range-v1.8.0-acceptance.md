# 范围映射与柱宽同步：v1.8.0 迁移验收

2026-10-06（Asia/Singapore）。独立分支 `feat/range-sync-settings-v1.8.0`，worktree `/home/quant/repos/market-watch-range-v180`，基线 `v1.8.0` / `b700911cff0b6f8448ac54e4355524891238efa8`。本页保留 v1.8.0 迁移历史。最新 main 集成的当前验收入口见 [main 集成验收](chart-range-main-integration-acceptance.md)。

## 当前行为

- 布局下拉末尾为“同步设置…”，集中设置范围映射背景/高低价矩形、主题默认颜色、自定义颜色、透明度和高低价标签。菜单名称统一为“范围映射”。高低价放在图表时间轴下方独立信息栏，与 K 线、坐标轴空间分离。
- 柱宽同步以实际接受可信用户缩放的图表为来源，不要求先激活或锁定焦点。滚轮、原生按钮、快捷键等实际横向缩放会带动其他就绪时间图；单纯开启、切焦点或程序恢复不主动统一。柱宽同步与日期范围同步互斥，对方变灰。
- 迁移保留 v1.8.0 连续历史、容量边界、原生光标重放、模板/Undo 保护；范围观察只记录已接受的数据，不恢复旧远历史窗口切换或重建机制。未证实的 SSE reset 不清已接受区间；已确认更正先作废旧元数据/ticket。
- 日期补偿识别真实容量边界，停止重复不可达目标。新的范围、配置、布局、商品、周期、容量或数据修订允许重新对齐；异步处理中收到重试会在当前操作收尾后补排。

## 隔离实例

Ubuntu 本机 `192.168.7.232` Docker，Compose project `mw-range-v180-20261006`。应用：<https://192.168.7.232:16743/advanced-charts>；图表来源：<https://192.168.7.232:16744>。独立 PG14 数据库/用户 `range_v180`、volume `range-pg`、网络和端口（PG 仅绑定 `127.0.0.1:16732`）。未创建或更新 unraid 实例，未影响其他验收项目。

私有配置目录 `/home/quant/repos/.acceptance/range-v180-20261006` 包含 compose、env、TLS 和登录资料，不提交。通知投递关闭，Yahoo 沿用禁用配置。验收登录资料保存在该私有目录的 `login.json`。自签 TLS 首次分别打开两个地址接受证书。

```bash
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/range-v180-20261006/compose.yaml up -d'
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/range-v180-20261006/compose.yaml stop'
```

## 验收状态

当前交互与范围浏览器回归 **169 项 / 14 组通过**，均 `errors: []`；旧版157项不计入本轮。最终证据位于 [v1.8.0 汇总](verification/chart-bar-range-mapping/v1.8.0/summary.json)。

| 专项 | 项数 | 证据 |
| --- | ---: | --- |
| 主流程、未激活图滚轮、8图60秒性能 | 31 | [main](verification/chart-bar-range-mapping/v1.8.0/final-main.json) |
| 原生选择与Undo/Redo | 4 | [choices](verification/chart-bar-range-mapping/v1.8.0/final-choices.json) |
| 按钮/快捷键/轴拖动、保存及恢复 | 20 | [extended](verification/chart-bar-range-mapping/v1.8.0/final-extended.json) |
| 触摸 | 6 | [touch](verification/chart-bar-range-mapping/v1.8.0/final-touch.json) |
| 信息栏几何、弹窗、菜单 | 5 / 5 / 6 | [geometry](verification/chart-bar-range-mapping/v1.8.0/final-geometry.json)、[modal](verification/chart-bar-range-mapping/v1.8.0/final-modal.json)、[menu](verification/chart-bar-range-mapping/v1.8.0/final-menu.json) |
| 三组旧date/time选择同widget与刷新 | 6 | [legacy](verification/chart-bar-range-mapping/v1.8.0/final-legacy.json) |
| 逐帧画面与时间稳定性 | 9 | [stability](verification/chart-bar-range-mapping/v1.8.0/final-stability.json) |
| 范围映射、8图/2000次移动、主题价格轴 | 39 | [mapping](verification/chart-bar-range-mapping/v1.8.0/final-mapping.json) |
| 九周期矩阵、同商品过滤 | 20 | [matrix](verification/chart-bar-range-mapping/v1.8.0/final-matrix.json) |
| NY17月界、DST/闰月/年界、东京时区 | 4 | [calendar](verification/chart-bar-range-mapping/v1.8.0/final-calendar.json) |
| 生命周期、历史静止鼠标/按住拖动 | 6 / 8 | [lifecycle](verification/chart-bar-range-mapping/v1.8.0/final-lifecycle.json)、[navigation](verification/chart-bar-range-mapping/v1.8.0/final-navigation.json) |

18项实际断言模块回归与5个浏览器辅助脚本加载检查均exit0；51个JS语法检查通过。chart/web镜像构建成功。运行中的 `host.1999756a8241911a.js` 与19个当前宿主模块拼接结果逐字节一致，另核验24个构建源文件摘要，见 [源码摘要](verification/chart-bar-range-mapping/v1.8.0/source-sha256.json) 与 [实际环境](verification/chart-bar-range-mapping/v1.8.0/environment.json)。

8图60秒新增工作 p95=1.2ms/帧，step到目标提交 p95=5.4ms，单目标每帧setter上限1；2000次移动无新增历史请求，元数据新增数量与实际图表接受的新bar逐key一致。原生线程10秒后台缓存清理不会清除图上已交付K线，不能要求元数据数量始终等于线程缓存数量。

原生连续历史完整产品链路（四图）已在最终candidate12通过：连续历史、四类失败恢复、取消、返回最新、按住拖动、真实PG更正、保存重开与Python指标前缀修订。真实修订触发1次重建，回调收到精确修订close；两类修订fixture均恢复原payload。最终candidate12的原生容量边界四图专项也通过。完整结果见 [原生全链路](verification/chart-bar-range-mapping/v1.8.0/final-native-continuous.json) 与 [容量边界](verification/chart-bar-range-mapping/v1.8.0/final-native-boundary.json)。

稳定性专项逐 rAF 检查有红/绿 K 线像素、原生 model/chart 身份保持、静止历史光标的公开时间、日期标签与价格栏不跳动。覆盖真实 OANDA W1/M5/H4/D1、深浅主题、反向 M5 来源、W1→MN 和东京时区。不能从有限采样保证所有设备/任意操作绝无闪烁。

时间关系按真实来源 `[start,end)` 验证：例如周线图表日期 `2025-12-01`，实际周区间从前夜22:00开始；M5 的 `2025-12-01 00:00`、H4 的前夜22:00都可以属于同一真实周区间。跨周期标签不要求文字相同，要求原生公开时间落在来源真实区间、静止加载前后语义不变。

## 回归修复与验证边界

旧布局复验捕获同一不可达月线目标一分钟被日期补偿尝试57次，阻塞真实历史更正；修复后6项旧布局场景通过。新增模块验证成功clamp、先拒绝再异步容量落点、处理中的容量retry、新来源优先、临时补齐失败与释放预算后重试。用户指定 `gpt-6.1-sol / max` 的 Spec/Standards 最终只读审查通过：未发现未解决的P1/P2或标准违规，运行镜像、源码与169项证据已绑定核验，见 [最终审核记录](verification/chart-bar-range-mapping/v1.8.0/review-final.md)。发现的P2均已修复。

范围元数据回收按实际缓存与当前图表已交付范围取并集；空线程不保留旧store/ticket，缓存清理/线程销毁后触发回收，迟到旧ticket不能复活。Python指标缓存不参与基础行情区间，避免窄指标缓存删除主行情元数据。模块覆盖平台/managed/Python、reserve关闭、重复绑定与live数据保留。

周期矩阵按实际区间与可见区交集判定；粗周期最新bar未覆盖小周期当前画面时不绘制。历史导航投影场景采用默认容量内的2025-12-01；原2024-03-04场景在200k实际请求边界停住，目标画面未覆盖该周，因此不把无标记误判为投影失败。日历冷历史的public range等待预算改为120秒，与v1.8.0任务加载链路匹配。

## 人工验收

已准备工作区 **v1.8.0 范围映射与柱宽同步验收**：W1/M5/H4/D1 四图、深色主题，范围矩形/高低价标签、时间同步与柱宽同步已开启，日期范围同步关闭；单源容量200,000根。刷新进入后可直接使用。

1. 开四图，打开柱宽同步。保持焦点图不变，直接把鼠标移到另一图滚轮缩放，其他图柱宽随它变化；再试原生缩放按钮/快捷键。仅切焦点或开启开关不应统一宽度。
2. 检查柱宽与日期范围互斥、范围映射开关样式和同步设置弹窗。调颜色/透明度、保存并刷新，配置保持。
3. W1 对 M5/H4/D1 开启时间与十字线同步，点历史周线，加载后静止鼠标观察日期/时间、范围矩形及高低价；移动后应仍对应同一真实区间。
4. 缩放、拖动、切换周期/布局、深浅主题；观察 K 线不反复清空、价格标签不触碰 K 线。降低容量后请求更早历史应停在真实边界并保持可操作；提高容量后可重试。

未合并、未部署生产。
