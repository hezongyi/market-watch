# 原生工具栏模型就绪修复验收

修复代码 `24a3dcd1`；真实启动回归脚本 `8b00315f`。基线 v2.0.1 / PR #123。
PR #124：https://github.com/hezongyi/market-watch/pull/124。

## 问题与修复

通用入口 `/advanced-charts` 恢复保存的五图工作区时，工具栏 `componentDidMount` 在内部模型创建前调用 `model()`，React 捕获并打印 3 条 `Value is null`。
图表对象存在不能保证模型就绪。旧补丁已处理销毁时的注销，但创建时仍过早读取模型。

`native-toolbar-lifetime.mjs` 提供自包含订阅函数，由许可资源 patcher 嵌入：
- 订阅活动图表及模型创建事件；模型就绪后绑定商品解析事件。
- 活动图表或同一图表的模型变化时释放旧绑定，再订阅新模型。
- 已解析的模型在绑定后刷新一次标题；后续解析事件继续刷新。
- 销毁时注销捕获的原订阅及模型等待回调，不再查询当前模型。

没有固定延时、吞异常或关闭商品名称功能。完整旧补丁可升级；未知字节、部分补丁拒绝写入。幂等、禁用还原及资源哈希 URL 继续有效。

## 最小检查与 CI

F0：局部工具栏生命周期修复；不改 API、schema、工作区或偏好保存格式。最小检查为本人自审、相关回归、完整 Web 构建和 Ubuntu R1 原生浏览器验收。

实际许可 bundle 的 hook 测试先失败于 `componentDidMount -> model -> Value is null`，修复后通过。

```bash
node --test web/tests/native-toolbar-model-ready.test.mjs
node web/tests/native-toolbar-lifetime.cjs
node web/tests/advanced-native-hook-contract.cjs
cd web
node tests/multi-chart-resolve-init.cjs
node tests/advanced-startup-metadata.cjs
```

6 项公开模型生命周期回归加入 Web CI。许可 hook 的延迟就绪/销毁/禁用/重复生命周期、旧补丁升级与篡改拒绝检查通过。原生资源缓存契约测试改为当前 manifest/直接挂载架构。

完整 Web 镜像通过 `mw-docker build` / `market-watch-ubuntu` 构建；TypeScript、Vite、许可补丁安装和单前端资源装配通过。
CI run `42730530869`：Backend/Web/Compose 及最终汇总全部成功，验证提交 `8b00315f`。

## 真实浏览器结果

Playwriter CLI 控制 Ubuntu 本机 Headless Chrome，真实管理员密码表单登录。
`web/tests/native-toolbar-startup.playwriter.cjs` 在基线准确失败：通用入口的 `console.error` 中 3 条 `Value is null`，而 `pageerror` 为 0。这说明只检查未捕获异常会漏报。

候选仅替换浏览器中的静态图表资源；实际开发实例验收撤掉该资源替换，使用服务真实返回的新版资源。真实行情读取未伪造。两轮均覆盖：

| 场景 | 候选 | 开发实例 |
| --- | --- | --- |
| 通用入口自动恢复，连续两次 | 通过 | 通过 |
| 保存工作区直接链接 | 通过 | 通过 |
| 刷新 | 通过 | 通过 |
| 同商品五图切换 | 通过 | 通过 |
| 离开图表到设置后重新进入 | 通过 | 通过 |
| 启动阶段 console.error / pageerror | 0 / 0 | 0 / 0 |
| 完整保存工作区前后相等 | 是 | 是 |

启动记录：`candidate-startup.json`、`development-startup.json`。
另通过商品搜索真实切换 XAUUSD → BTCUSDT，工具栏标题及图表元数据完成更新，`Value is null` 和 pageerror 均为 0。见 `symbol-update.json`。
此检查仅在浏览器内确认保存请求，不向服务保存测试的工作区/偏好；随后重载原保存布局，完整工作区内容相等。

观察到一次独立的 `/api/notification-center/observations` HTTP 404，发生于启动验收之后的商品切换检查期；这项通知观察接口问题不在本次工具栏修复范围，未计为 Value is null，也未声称解决。

## 环境、运行与交付边界

Ubuntu 主机 `quant-server`，开发 project `mw-dev`，地址 https://192.168.7.232:18443/ 。
开发启停：`mw-dev up` / `mw-dev stop`；启停服务并保留数据。当前运行开发实例已更新，不需要重新启停；浏览器刷新即可加载新图表资源。

候选 task/project `mw-toolbar-ready-20261110`：仅一个 128 MiB、0.1 CPU 静态资源容器，独立网络，回环地址 http://127.0.0.1:19655/ 。未新建或共享可写数据库服务。任务专有 Compose 在本 worktree 的私有 `artifacts/toolbar-ready/compose.json`，启停：

```bash
docker compose -p mw-toolbar-ready-20261110 -f artifacts/toolbar-ready/compose.json up -d --no-build
docker compose -p mw-toolbar-ready-20261110 -f artifacts/toolbar-ready/compose.json stop
```

验收后停止该静态容器，保留镜像与配置供复核；自有浏览器页及会话关闭。没有删除永久数据，没有操作 unraid，没有新建正式 tag，没有合并 PR #124。

应用镜像：`sha256:8cb849b595aea3198c5ca5396baa3318b985aec17a7e194ac29931b2b5cca4d8`，干净应用提交 `24a3dcd1` 构建；后续提交只含回归脚本/验收文档。
图表目录 `charting_library_2c027038855aa351`；适配脚本 `chart.1ba5bf123f0f62c5.js`。
开发部署记录在私有 `~/.local/share/market-watch-dev/updates/toolbar-ready-20261110/deployment.json`；前一版 manifest/资源保留，可回退。

本人自审：原生挂载处调用的就是 CI 测试的自包含订阅函数；不再通过当前关联图表查询销毁对象。活动图表切换不依赖商品代码变化；就绪等待不会永久漏订阅，退出后回调不再生效。真实五图启动和商品更新补充验证了测试替身无法覆盖的原生行为。
