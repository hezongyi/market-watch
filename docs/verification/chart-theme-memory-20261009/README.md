# 刷新后主题一致性验收

2026-10-09，Asia/Singapore，基线 `2b7f677`。

## 原因与行为

主题已有账户级保存，但图表库的构造 `theme` 只决定工具栏等界面主题，`saved_data` 同时恢复布局里的独立画布与价格轴颜色。旧布局仍是白色时，账户选择 Dark 后刷新会出现暗色工具栏与白色画布。之前主题测试仅断言 `getTheme()`，因此漏掉该问题。[修改前复现](before.log) 精确失败于 Dark 画布仍为 `#ffffff`。

新增 `chart-theme.js` 统一校验并选择主题：有效账户 `mw.theme` 优先，兼容旧原生主题设置，再回退布局标记、旧文档主题和 Dark。原生布局保存时记录 `_mwTheme`，启动及原生加载布局完成时协调颜色。布局所属主题与当前记住的选择不同，调用公开 `changeTheme`，同时恢复全部图格；恢复过程不加入撤销历史，也不把恢复动作重新写成用户主题选择。

同一主题保存的自定义背景、蜡烛颜色和价格轴字体保留。旧布局没有主题标记时，仅识别图表库默认黑／白背景和默认价格轴文字颜色，修复明显的旧默认配色冲突；没有这类默认冲突的自定义背景保留。新的主题标记不传入原生布局结构，保存在既有主机扩展字段中。账户主题保存保持使用原有有版本校验的串行设置适配器，独立于布局自动保存开关。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| 旧白布局＋Dark、真实菜单两种主题／关闭布局自动保存、同主题自定义样式、无标记自定义背景、原生加载布局、两个图格、不同主题标记、旧原生主题回退 | [浏览器报告](restore-report.json)，9 组通过，无页面错误 |
| 真实服务器保存主题、刷新检查画布／价格轴／工具栏、菜单键盘操作、紧凑宽度 | [真实菜单报告](real-menu-report.json)，Dark／Light 两组通过；临时自有工作区删除，原账户主题恢复 |
| 原生指标弹窗及数据中心样式、暗／亮三种宽度、入口相邻关系、刷新与焦点 | [原生 UI 报告](native-ui-report.json)，7 组通过，无页面错误 |
| 主题有效值与优先级、标记、旧默认配色、多图和自定义背景保护 | [单元日志](unit.log)，22 项通过 |
| 原图表样式／网格适配器、设置队列／版本冲突／只读、价格格式 | [style.log](style.log)、[preferences.log](preferences.log)、[price-format.log](price-format.log)通过，价格格式 38 项 |
| Ubuntu 专用 BuildKit 镜像、JavaScript 语法、差异检查 | [构建日志](chart-build.log)、`node --check`、`git diff --check`通过 |

浏览器串行运行。9 组恢复测试使用真实图表库和数据服务，工作区及设置的写入由内存服务拦截，未覆盖既有用户工作区；另运行真实服务器主题保存验证并恢复原设置。真实菜单旧测试补充了背景与轴文字断言。截图：[暗色](dark-menu.png)、[亮色](light-menu.png)、[刷新恢复的亮色双图](restored-light-two-charts.png)。

## 实际运行环境及启停

Ubuntu 22.04 `quant-server`（`192.168.7.232`）本机 Docker，task/project `mw-data-center-review-20261008`，独立网络、PG volume、数据库与 19943/19944 端口；只更新图表服务。构建经 `mw-docker build --component chart --task mw-data-center-review-20261008 --project mw-data-center-review-20261008 --purpose acceptance` 和 `market-watch-ubuntu` BuildKit。没有使用 unraid 或生产资源。

访问 <https://192.168.7.232:19943/advanced-charts>，图表 origin <https://192.168.7.232:19944>。密码不变；凭据、私钥、许可库与完整浏览器状态未提交。九个服务运行，API／PG 健康；状态、镜像 ID 和归属见 [runtime.json](runtime.json)。保留供验收，生命周期任务仍进行中，没有资源退役或清理。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```
