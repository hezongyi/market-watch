# 同步设置阶段 A 技术决策

> 本页为 v1.8.0 迁移前的历史实现/验收记录；焦点来源等旧合同已由用户修订。当前分支的代码、Ubuntu 实例与复验结论见 [v1.8.0 迁移验收](chart-range-v1.8.0-acceptance.md)。

2026-10-04，基线 `279b1ef` 后的实施候选。实际主机 Ubuntu `192.168.7.232`，独立 Compose project `mw-sync-settings-ubuntu-20261004`，应用/图表端口 `16243/16244`。与已有 `16043/16044` 用户验收实例隔离；无 unraid 操作。

三项实现入口已选择，candidate9已完成正式复验及源码/镜像字节绑定。最终范围、运行方式和全部结果见[实现验收](chart-sync-settings-acceptance.md)；下面保留阶段A的决策与定向证据：

1. **用户缩放归因：SHA 校验原生动作 adapter。** 公开回调无原因信息，不能证明关联。adapter 在实际 wheel、原生 zoomIn/out 动画、框选、时间轴拖动和 pinch 入口建立 token；同步输入入口要求同一原生文档当前 trusted event，动画把 token 捕获在 onStep/onComplete 闭包。step 比较该实际动作前后值，不传播程序 setter 的公开事件。探针真实 wheel、Ctrl+ArrowUp 动画穿插程序 setter、focus+程序 setter、框选通过，无页面异常。记录见 [因果链探针](verification/chart-bar-range-mapping/sync-settings/implementation/stage-a-causality.json)。本探针当时未覆盖时间轴、pinch、完整按钮和取消，不能只据阶段A探针声称全部输入已验收；这些输入已由最终candidate9 main/extended/touch补齐。
2. **暂停执行：窄写入作用域与 SHA 校验 handler。** 内部暂停进入 `MWNativeSync.write` 的同步 try/finally 作用域，date/time handler 仅对此作用域直接写 internal watched value，沿用原生有效状态分发而不创建 UndoCommand。不借全局 loading 标志，不清空 Undo。探针前后实际 UndoCommandCount、native Save 状态和宿主 dirty 均不变。date/time 用户选择通过原生 undoHistory.setWatchedValue 创建逻辑命令，暂停执行写入不入 Undo。time 命令只捕获 time 布尔值，date 命令只捕获 none/date/barWidth 模式；撤销不覆盖独立字段。新增柱宽开关首版不创建 UndoCommand，但标 dirty 并保存。缩放 Undo/Redo 传播不是首版硬要求。选择与恢复只有协调模块持有，guard/capture/restore/legacy/edge/bridge 均迁移为令牌；嵌套、最新期望、旧代次和重复释放的模块测试通过。candidate8 choices（4项）及 extended（20项）已验证真实点击/键盘、暂停原生 Undo/Redo、独立time Undo、干净暂停、A/B原生Save读回和失败后恢复副本。
3. **价格标签：首版固定外部信息栏。** 原生价格轴的碰撞占位无法取得可靠准入证据，首版采用方案允许的外部回退；不交付未经证明的轴标签。通过 SHA 校验 `_height` 入口从真实 chart slot 高度扣除 36 CSS px，栏为 `_parent` 中的 sibling，行情 pane 高度减少 36px，栏位于时间轴之后，空间零相交。[几何探针](verification/chart-bar-range-mapping/sync-settings/implementation/stage-a-geometry.json)为真实 DOM 测量。candidate8 main/extended/geometry 已验证深浅主题、8图窄窗、真实BTC长价格、左轴/多轴、副图、最大化、DPR2、125%等效布局尺寸及16px标签字体，未见相交或测试范围内文字裁剪。这不代表所有OS字体设置。安装版不能将唯一主价格源改为no-scale，采用主源左轴验证右轴不存在；不声称已实现原生不支持状态。不允许图内 overlay。预留由配置决定，hover 清空内容保留空间。

性能预算：前台 Chromium 1243、Ubuntu、1600×1000，8图连续操作60秒；新增同步/标签工作 p95≤8ms/帧，用户实际 step 到目标提交 p95≤下一 rAF+8ms。每目标每帧至多一次 setter；当前代次每目标最多一个待提交值；20次布局/工作区切换后 dispose 无新增订阅/内容 DOM 残留。candidate8 main 实测新增工作 p95=1.0ms/帧，step 到目标提交 p95=3.4ms，单目标单帧 setter 上限1；20次布局循环及真实dispose均通过。最终candidate9同方法实测p95=0.80ms/帧，step提交p95=2.0ms，最大单目标单帧setter=1，结果见实现验收。

复现工具：探针临时脚本在 `/tmp/mw-sync-settings-implementation`；可复跑浏览器脚本已保存在 `web/tests`，入口如下。本机浏览器依赖路径为 `LD_LIBRARY_PATH=/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu`，许可库与登录凭据不提交。


## 复跑入口与结果合同

在 worktree 的 `web` 目录运行。下列环境只访问 Ubuntu 独立验收项目；登录文件为本地凭据，不输出、不提交。真实 provider 浏览器脚本串行运行，避免请求竞争及偏好版本冲突。

```bash
cd /home/quant/repos/market-watch-range-mapping/web
export RANGE_APP=https://192.168.7.232:16243
export RANGE_CHART=https://192.168.7.232:16244
export RANGE_LOGIN=/home/quant/repos/.acceptance/market-watch-sync-settings/login.json
export LD_LIBRARY_PATH=/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
RANGE_OUTPUT=/tmp/mw-sync-settings-main.json node tests/advanced-sync-settings.browser.cjs
# 同样串行运行 advanced-sync-settings-{choices,extended,touch,legacy,geometry,modal,menu}.browser.cjs
# 范围回归：advanced-bar-range-{mapping,lifecycle,navigation,matrix,calendar}.browser.cjs
```

每个结果必须没有 `failure` 且 `errors: []`，子进程 exit 0；原生日期回归 `advanced-native-date-sync.browser.cjs` 使用 `NATIVE_SYNC_APP/CHART/LOGIN` 及 `NATIVE_DATE_SYNC_OUTPUT`，还要求 `passed: true`。模块测试从 `web` 运行，详见实现验收记录。探针与旧候选保留各自阶段标识，不混入最终通过数。
