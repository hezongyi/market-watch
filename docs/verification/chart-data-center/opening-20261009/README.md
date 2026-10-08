# 数据中心打开图表交互验收

日期：2026-10-09，Asia/Singapore。源码基线 `ddf9263` 加本报告同提交的修改。

## 问题与修复

点击一个平台品种时，列表中 25 个按钮都显示“正在打开…”，见[修改前复现](opening-before.log)。
原因是每个 OpenChart 都用窗口级 `busy` 替换按钮文字并设置 disabled；弹窗关闭又等待窗口校验、图表侧校验，以及原生品种/周期的数据加载结果。

- 每个按钮独立显示 opening/aria-busy；其他按钮保留文字和外观。窗口级锁通过 aria-disabled 与事件检查防止重复提交，快速连点仍只发送一个命令。
- 窗口不再重复请求来源校验。图表主机同步检查所捕获的工作区、图格、品种/周期与命令身份，接收后立即关闭数据中心并恢复工具栏焦点。
- 保存所选列表的位置与筛选，关闭管理 iframe 后由图表主机继续校验和加载。慢请求不阻塞弹窗关闭。
- 加载状态、来源失败和重试放在图表上的可关闭提示中，使用 status/alert 语义、深浅主题与键盘焦点。加载完成时自动移除。长时间加载提供说明和重试；重试可刷新当前系列数据。
- 使用公开的每图格 setSymbol/setResolution/dataReady/resetData 接口；每次后续修改前检查操作归属及当前周期。重开数据中心、更换布局/图格/工作区或后续用户选择会使旧请求失效，旧回调不会覆盖新选择。
- 打开前目标已失效时保留弹窗并提示重新打开；行情与周期同步在实际应用前关闭，其他图格保持原身份。

## 验证

7 套浏览器验证共 45 组通过，全部报告 `passed=true`、`errors=[]`。本轮只修改前端与图表主机；后端和数据结构未改。

| 范围 | 结果 |
| --- | --- |
| 单行状态、25 行列表、快速连点、慢来源、慢 K 线、长等待重试、图表加载提示清除、工具栏焦点 | 5 组；[opening-report](opening-report.json) |
| 陈旧布局拒绝、来源 503 与恢复重试、后续活动图格、新周期、工作区世代、同步锁开启时的单图格修改 | 6 组；[opening-guards-report](opening-guards-report.json) |
| Binance/Yahoo 的真实平台目录与打开 | 2 组；[platform-report](platform-report.json) |
| 固定历史版本、多图目标、原生配置、维护编辑、浅色及全屏 | 6 组；[flows-report](flows-report.json) |
| 列表/详情位置与筛选、读取失败、图表指标/画线/视区保留、最大化、弹窗协调、Esc、延迟校验失效、未保存保护 | 12 组；[resilience-report](resilience-report.json) |
| 五分区、1024/1440/1920、200% 内容缩放、未保存保护、浏览记忆与焦点 | 7 组；[browser-report](browser-report.json) |
| 原生样式对照、深浅主题 × 三宽度、图标/入口顺序及刷新 | 7 组；[native-ui-report](native-ui-report.json) |

完整串行记录见[opening-regression.log](opening-regression.log)。最终提示文案整理后再跑 11 组关键检查，见[opening-final-checks.log](opening-final-checks.log)。慢网络测试通过浏览器明确挂起请求和回调，不依赖供应商偶然变慢；图表操作使用实际原生接口。最终测量在检测到窗口消失时立即停止计时，弹窗为 279ms（包含命令反馈检查 + 慢来源）和 149ms（慢 K 线），见[opening-final-timing.log](opening-final-timing.log)；均发生在被挂起请求释放之前。关闭耗时受浏览器和主机负载影响，不作为固定响应时间承诺。

TypeScript/Vite、web/chart Docker 构建、修改脚本语法及 `git diff --check` 通过。许可库未修改。
截图：[深色慢 K 线](opening-candles-dark.png)、[浅色失败可重试](opening-source-error-light.png)。

## Ubuntu 验收实例与启停

运行于 Ubuntu 22.04 `quant-server` (`192.168.7.232`) 本机 Docker，task/project 为 `mw-data-center-review-20261008`。
沿用本任务独立 Compose 网络、数据库/volume 和 19943/19944 端口。web/chart 经 `mw-docker build`、`market-watch-ubuntu` builder、`purpose=acceptance` 构建更新。九个服务运行，API/PG 健康；镜像 ID、状态与任务归属见[runtime.json](runtime.json)。未使用 unraid 或生产资源。

访问：<https://192.168.7.232:19943/advanced-charts>。旧 `/market-data` 地址兼容。密码保持不变。
私有密码、Compose/env、证书私钥、许可库和浏览器状态不提交仓库。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

验收实例保持运行，生命周期任务仍进行中。本轮未执行资源退役、删除数据库或全局清理。
