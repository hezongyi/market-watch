# v1.20.4 原生告警和数据中心依赖修复交付

## 根因与实现

专业图表的原生告警适配器初始化 Select 时，没有等待 DOM IDs（210754，chunk 32171）和键盘导航（409286，chunk 36145）的共享模块。资源并发加载时，第一次 require 失败，Webpack 缓存了部分初始化的 Select exports；随后数据中心读取同一缓存，连续出现“原生告警接入失败”和“原生界面适配不可用”。

v1.20.4 在读取控件前显式等待两个共享 chunk，不改许可库内容、原生界面或工作区会话保护。PR #43，release source d4298b6ed8fbc9a7c1fb68e31ac857ed7da0b84a。v1.20.3 只补齐一个共享 chunk，生产循环复验第 4 次失败后回退 v1.20.2；保留历史 tag。

## 实现和候选产物验证

- Standards 和 Spec 独立复核：各 0 项发现。
- Chromium 124、153 双资源延迟回归通过；八资源并发延迟回归通过。
- 首次控件 require 前检查真实 runtime factory，独立复核同步依赖闭包 130／131 个模块，等待后缺失 0。
- 实际生产页面仅浏览器替换修复响应的 10 轮验证通过。
- Ubuntu 隔离 Docker 构建的真实 host 字节替换浏览器响应，8 轮通过。
- 既有原生告警 UI 集成 13 项通过；不保存真实告警，不改用户设置。

## 验收环境

Ubuntu quant-server，独立 Compose project `mw-native-dependency-closure-20261011`，无生产数据库或数据卷；验收地址 `http://127.0.0.1:18984`。构建经 mw-docker 和 market-watch-ubuntu BuildKit，目的 acceptance。结束后按 task／project 精确退役。

启动／停止命令（实例退役后应重新构建，不承诺此地址继续运行）：

```bash
sg docker -c 'docker compose -p mw-native-dependency-closure-20261011 -f /tmp/mw-native-dependency-v1204-20261011/compose.acceptance.yaml up -d --no-build'
sg docker -c 'docker compose -p mw-native-dependency-closure-20261011 -f /tmp/mw-native-dependency-v1204-20261011/compose.acceptance.yaml stop'
```

## 证据边界与已知后续问题

未直接取得用户完整异常后缀或其个人浏览器堆栈；本机 WebKit 受 EGL 环境限制，未把 Safari 记作验证通过。

候选构建生产浏览器验证的首次运行另遇 `/api/charts/data` 500，服务端确认为已有 `market_data_demand_pkey` 并发首次插入冲突，与共享模块故障不同。该问题也记录于 v1.20.2：建议把 `renew_demand` 的 SELECT 后 INSERT 改为保留身份的原子 upsert，配合 PostgreSQL 同键并发回归。未在本次修复中改动后端，也未将首次失败记作通过。

## 正式生产结果

2026-10-11 已正式切换到 `releases/v1.20.4-d4298b6`。访问地址：`https://trade.kookvv.com:8443/advanced-charts`。Ubuntu 构建，unraid 仅运行正式生产；不存在 unraid 开发／验收实例。

12 个运行服务均为正式 release 镜像，API healthy、版本 1.20.4，工作区／告警／账号／通知配置指纹保持一致。展开后的 14 个服务定义除镜像引用外有效配置一致；全部后端 Yahoo 为 true，实际 AAPL 元数据、D1 柱和报价读取通过。部署 host 与 Ubuntu 验收产物字节相同，哈希为 `623db7406d0dae8802c00a3acbfe95169b685947b7cde1a72f2b793da335fafd`，许可库前缀不变。

正式资源未经浏览器替换，Chromium 124 连续 10 轮、Chromium 153 连续 5 轮打开专业图表和数据中心通过；每轮原生告警就绪、单一告警入口、原生数据中心可见，无两个原生提示，无 page error 或 HTTP error。另通过原生告警弹窗及焦点恢复、数据中心六栏及来源状态、原生指标窗口、真实 SSE 柱／报价、390px 首页检查。没有保存真实告警、改密码或测试通知；所有浏览器会话退出。

首轮生产浏览器仍遇到既有 `/api/charts/data` 500（`market_data_demand_pkey`）。后来正常循环不代表此独立冲突已解决；本次仅完成两个原生初始化故障修复，不能据此宣称全部功能在所有条件下正常。扩展检查首次探针访问尚未定义的 `ready` 变量，修正探针等待条件后通过，没有改生产代码。Safari 本机未完成验证，生产观测为短时验证。

本次新数据库／配置备份及哈希校验成功，没有结构变更，本次没有重新实际恢复数据库；最近的 Ubuntu 实际恢复证据为 v1.20.2。保留 v1.20.2 正式镜像和配置回滚路径：`deploy/native-dependency-v1.20.4-switch-20261011/rollback.sh`。

Ubuntu 验收 project 已按 mw-docker 精确退役，无数据库／数据卷，不适用数据库恢复步骤。删除一个本任务容器、网络及验收镜像；保留正式／回滚镜像。不执行全局 prune，不影响其他任务。工具第一次因可用空间不足 10 GiB 拒绝退役，核实并删除本任务未使用的 WebKit 环境、已取消下载临时文件和已解压 Chromium 压缩包后，通过正常退役入口。正式生产 12 个服务保持运行，切换用的私有预览 env 已清理。

生产启动／停止（仅在维护时执行）：

```bash
ssh unraid 'cd /mnt/user/appdata/market-watch; ./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker market-stream-worker web chart-origin'
ssh unraid 'cd /mnt/user/appdata/market-watch; ./tools/docker-compose -p market-watch -f compose.release.yaml stop api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker market-stream-worker web chart-origin'
```

发布清单：[v1.20.4-production.json](../deploy/releases/v1.20.4-production.json)。原始日志、浏览器完整状态、私有 env、凭据及许可库不提交。
