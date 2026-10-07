# 同步设置、柱宽同步与范围映射：实现验收

> 本页为 v1.8.0 迁移前的历史实现/验收记录；焦点来源等旧合同已由用户修订。当前分支的代码、Ubuntu 实例与复验结论见 [main 集成验收](chart-range-main-integration-acceptance.md)；[v1.8.0 迁移验收](chart-range-v1.8.0-acceptance.md)保留为历史。

2026-10-05（Asia/Singapore）。独立 worktree `/home/quant/repos/market-watch-range-mapping`，分支 `feat/chart-bar-range-mapping`，实现基线 `279b1ef`。按 [审核修订方案](chart-sync-settings-plan.md) 实施，阶段 A 决策见 [技术记录](chart-sync-settings-stage-a.md)。本次完成本地实现与 Ubuntu 验收，生产发布仍待用户另行授权。

## 交付行为

- 布局菜单显示“范围映射”“柱宽同步”，移除两个常驻样式按钮；整个菜单末尾为“同步设置…”。扩展开关采用安装版原生 checked 皮肤，深浅主题下已测量比较尺寸、滑块位置与颜色，并核对截图。
- 同步设置弹窗集中显示背景/高低价矩形、跟随主题或自定义颜色、0–100%透明度、高低价显示。默认深色白色/88%透明，浅色灰色/85%；预览与真实填充共用计算规则。恢复默认只改草稿，取消/Esc/关闭不提交；Tab后Enter执行所聚焦按钮自己的动作。
- 柱宽同步仅跟随焦点图的真实用户横向缩放：滚轮、原生按钮/快捷键动画、放大框选、时间轴拖动/双击、触控pinch。开启开关或仅切焦点不统一柱宽；程序恢复、价格缩放及平移不传播。每目标每帧至多一次，旧操作取消不重放。
- 柱宽与日期范围同步互斥；开启其中之一，另一项关闭并禁用变灰。time选择独立。协调模块统一持有逻辑期望与可嵌套暂停，菜单、保存、加载不会把临时native false当作用户选择。
- 高/低实际价格使用目标商品formatter，在主pane外固定36 CSS px信息栏分两行显示，纵向屏外注明状态。栏与K线绘图区零相交，不随hover重排。必要开关、目标身份、周期和真实横向交集全部通过才显示；来源图与MN→W1不显示。
- 配置升级为`_mwBarRangeMapping` v2，`_mwSync`增加barWidth。旧native date/time的1/true在加载前迁移，现代元数据优先，非法双开保留date。仅恢复配置，不恢复鼠标或待执行缩放。
- date/time用户选择保留原生Undo，time命令仅保存time bool，date仅保存模式；内部暂停不创建Undo或dirty。柱宽开关首版不入Undo，但正常dirty/保存；缩放Undo/Redo传播非首版硬要求。
- 保存A完成后B仍保留宿主/native未保存及真实Save菜单可用，实际保存并服务器读回B。失败沿用blocked原ID与复制恢复副本路径，不取消原有保护；只读临时调整不写服务器。

## 实际环境及运行字节

Ubuntu本机 `192.168.7.232`，独立Docker Compose project `mw-sync-settings-ubuntu-20261004`，专属数据库、volume、network与端口。未操作既有`16043/16044`用户实例及unraid。所有验收通过此实例的真实API/PG/provider/native图表链路。

- 应用：<https://192.168.7.232:16243/advanced-charts>
- 图表来源：<https://192.168.7.232:16244>
- Compose：`/home/quant/repos/.acceptance/market-watch-sync-settings/compose.yaml`
- 最终图表镜像：`mw-sync-settings-chart:candidate9`
- image ID：`sha256:a7c81c0a704c0062935005093d4f2c581417cee417cefbddd78aa7a4a4a98215`
- 运行宿主资源：`host.0046aa12497a61ec.js`；拼接资源及各模块/CSS摘要已与当前源码逐项一致。

[environment.json](verification/chart-bar-range-mapping/sync-settings/implementation/environment.json)记录运行服务/image、许可原始/补丁SHA、浏览器与主机；[source-sha256.json](verification/chart-bar-range-mapping/sync-settings/implementation/source-sha256.json)绑定源码字节。许可库、登录、env、TLS私钥、完整浏览器状态不提交。

```bash
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/market-watch-sync-settings/compose.yaml ps'
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/market-watch-sync-settings/compose.yaml up -d'
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/market-watch-sync-settings/compose.yaml stop'
```

自签TLS首次需分别打开应用及图表来源接受证书。验收密码仍在上述受限本地目录的`login.json`。

## 最终验证

下列浏览器结果来自candidate9，串行运行exit 0、无failure且`errors: []`；模块及syntax按各自exit 0判断。[汇总](verification/chart-bar-range-mapping/sync-settings/implementation/verification-summary.json)记录157项浏览器场景，另有原生日期保存恢复通过、14个模块脚本、9个源码syntax检查、补丁幂等/迁移/disable/未知字节拒绝、`git diff --check`及前端build通过。build仅有既有大chunk提示。

| 组 | 场景数 | 最终证据 |
| --- | ---: | --- |
| 主行为、互斥、外观、2/4/8图、轴模式、性能 | 30 | [main](verification/chart-bar-range-mapping/sync-settings/implementation/final9-main.json) |
| 原生按钮/时间轴、边缘定位、多商品、保存A/B/恢复副本、20布局循环 | 20 | [extended](verification/chart-bar-range-mapping/sync-settings/implementation/final9-extended.json) |
| 暂停菜单/原生Undo、time独立与互斥 | 4 | [choices](verification/chart-bar-range-mapping/sync-settings/implementation/final9-choices.json) |
| trusted pinch、滚轮/平移、只读、dispose | 6 | [touch](verification/chart-bar-range-mapping/sync-settings/implementation/final9-touch.json) |
| 三组旧date/time存档同widget与刷新启动 | 6 | [legacy](verification/chart-bar-range-mapping/sync-settings/implementation/final9-legacy.json) |
| 真实BTC长价、多轴、DPR2、窄八图、字体/尺寸 | 5 | [geometry](verification/chart-bar-range-mapping/sync-settings/implementation/final9-geometry.json) |
| Tab/Enter取消、关闭、默认、确认、数值输入 | 5 | [modal](verification/chart-bar-range-mapping/sync-settings/implementation/final9-modal.json) |
| 深浅×开/关原生皮肤几何及Space禁用 | 6 | [menu](verification/chart-bar-range-mapping/sync-settings/implementation/final9-menu.json) |
| 范围映射核心、实时及零请求、held拖动、持续性能 | 38 | [mapping](verification/chart-bar-range-mapping/sync-settings/implementation/final9-regression-mapping.json) |
| 画线/Undo、Save As、load/reset及held拖动 | 6 | [lifecycle](verification/chart-bar-range-mapping/sync-settings/implementation/final9-regression-lifecycle.json) |
| 远历史、静止鼠标重投影及清除 | 8 | [navigation](verification/chart-bar-range-mapping/sync-settings/implementation/final9-regression-navigation.json) |
| 九周期两轮八图及身份过滤 | 19 | [matrix](verification/chart-bar-range-mapping/sync-settings/implementation/final9-regression-matrix.json) |
| NY17日历、DST/闰年/跨年 | 4 | [calendar](verification/chart-bar-range-mapping/sync-settings/implementation/final9-regression-calendar.json) |
| 日期/time历史视区保存/刷新恢复 | passed | [native date](verification/chart-bar-range-mapping/sync-settings/implementation/final9-native-date.json) |
| 模块/保存/安装合同及syntax | 14+9 | [modules](verification/chart-bar-range-mapping/sync-settings/implementation/final9-modules.json) |

前台Chromium1243、1600×1000八图60秒：新增工作p95 **0.80ms/帧**，实际step到目标提交p95 **2.0ms**，每目标每帧最大setter **1**，均在冻结预算内。最大单帧工作14.5ms，预算按p95判断，不承诺每帧或所有设备都低于8ms。

截图包括[浅色菜单](verification/chart-bar-range-mapping/sync-settings/implementation/final9-menu-Light-true.png)、[较大字体八图](verification/chart-bar-range-mapping/sync-settings/implementation/final9-geometry-eight-16px-effective-label-font.png)、[实际按住拖动](verification/chart-bar-range-mapping/sync-settings/implementation/final9-regression-mapping-eight-held.png)。hover零请求先等待后台reserve及几何稳定；正常柱宽缩小所需扩展历史不计入hover零请求合同。

## 审核、限制及复跑

用户指定`gpt-6.1-sol / max`方案agent完成审核及修订复审；同模型/强度Spec与Standards agent完成候选复审。旧发现及最后modal P2均已关闭，无遗留P1/P2，详见[审核记录](chart-sync-settings-plan-review.md)。历史候选结果保留于证据`historical/`目录，不计入上述通过数。

首版始终采用外部信息栏；原生轴对位标签为后续项。安装版不支持唯一主价格源no-scale，主源移到左轴验证右轴不存在，多轴单独实测。125%用等效viewport/DPR验证几何，没有操作浏览器缩放UI；16px字体验证不代表全部系统字体设置。当前日历回归使用OANDA EURUSD；原有Yahoo真实缓存/Binance日历证据保留其先前版本与范围，不虚称本轮重新获取Yahoo历史。

浏览器复跑环境与命令见[阶段 A](chart-sync-settings-stage-a.md)。需串行运行`advanced-sync-settings.browser.cjs`及`advanced-sync-settings-{choices,extended,touch,legacy,geometry,modal,menu}.browser.cjs`，以及表中范围/native日期脚本。模块脚本从worktree的`web`目录执行；许可库升级需重新探针，不沿用当前SHA锚点。
