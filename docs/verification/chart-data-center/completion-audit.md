# 图表内数据中心实现验收

日期：2026-10-08。任务分支 `feat/chart-data-center-20261008`；基线 `6fd9273`，
实现提交 `0d1d53d`，收口修复提交 `1dc99d9`。
依据[图表集成方案第9节](../../chart-data-center-integration-plan.md)，保留原三层行情业务规则。

本轮实现唯一原生工具栏入口、原生文档内dialog、可信app-origin管理iframe、五分区内部导航，
以及准确主图应用、编辑保护、旧地址兼容和异常反馈。图表不会因管理浏览重新挂载。
正式生产发布尚未执行；长期质量观察不属于本次实现验收，未宣称已经通过。

## 第9节逐项证据

下列JSON来自实际浏览器脚本，截图只选取无凭据的页面。所有脚本使用相同
[共享fixture](../../../web/tests/chart-data-center-fixture.cjs)，最终轮串行运行以避免工作区自动保存互相干扰。

| 验收范围 | 证据及行为 |
| --- | --- |
| 唯一入口 | [browser-report](browser-report.json)：原生工具栏末尾单个图标，重复打开一个窗口；侧栏、行情搜索和回测的可见直达入口移除，旧地址保留兼容 |
| 原生一致性 | [flows-report](flows-report.json)、[resilience-report](resilience-report.json)：深浅主题、真实浏览器全屏、图格最大化及指标窗口协调通过；使用公开createButton接口，SVG只装饰公开按钮。本任务未新增许可bundle修改，基线reserve构建补丁继续沿用 |
| 图表保留 | browser/resilience：五分区、详情、返回及关闭保留同一主图frame；真实指标、画线、双格布局和可见区间保留 |
| 图表应用 | flows/management/resilience：MWP平台及其完整配置身份、MWH固定版本、MWC组合准确；仅捕获图格变更；同步开启、目标失效、应用失败重试及resolution等待期间工作区世代变化均覆盖 |
| 管理流程 | [management-report](management-report.json)、[lifecycle-report](lifecycle-report.json)：真实UI添加GBPUSD→后台准备→发布→在主图打开；维护计划保存及暂停恢复；区间任务暂停/恢复/重试/取消；明确映射保存和组合使用；版本详情、真实引用保护、归档、影响核对及无引用历史回收 |
| 数据副作用 | browser/management：五分区浏览前后不新增需求、组合或维护任务；明确打开/提交后才发生相应动作，关闭窗口后真实供应商发布继续 |
| 导航兼容 | browser/flows/layout/resilience：旧列表、详情、平台配置、固定版本进入同一原生窗口；认证回跳、无工作区创建、返回行焦点、分区筛选分页记忆及失效对象恢复 |
| 编辑与并发 | [concurrency-report](concurrency-report.json)、resilience/management：关闭、返回、切区、刷新保护未保存输入；同步连续两次创建只发一次POST；旧响应不导航或清空新表单；丢失成功响应按request_id找回；20秒保存超时保留字段和释放按钮；旧读取不串写 |
| 可访问性 | browser/layout/zoom/resilience：Tab限制与关闭返回焦点、Esc先关闭筛选/原生选择/详情菜单、命名及状态反馈；Dark/Light主要正文、次要文字和链接对比度均达到4.5:1。此证据不替代人工屏幕阅读器完整审计 |
| 桌面布局 | [layout-report](layout-report.json)、[zoom-report](zoom-report.json)：1024/1440/1920、长中文/长代码及真正Chrome200%缩放；标题、筛选入口和分页保持可见，表格独立横纵滚动，主要操作可达；组合候选和已建立列表各25行fixture均覆盖 |
| 异常反馈 | resilience/lifecycle/initialization：初次失败、筛选无结果、空列表、旧快照及刷新重试区别明确；维护失败不遮旧历史；[initialization-report](initialization-report.json)证明首次保存409失败保留数据中心与草稿恢复，并显示原始错误 |

### 目标图格及同步行为

公开API实测发现重新开启品种或周期同步会立即传播活动图格的变化。为满足仅目标图格应用，
窗口底部在同步开启时明确说明：打开将关闭品种和周期同步；实际应用时关闭这两项并保留其他同步。
两格实测：目标由MWP/XAUUSD H4转为指定MWH M1，另一格仍保持MWP/XAUUSD H4。
每个异步阶段均检查工作区ID/世代、layout、图格对象/index及活动格；失效后停止后续操作并提示重新打开。
已经发给原生图表的异步变更无法撤销，错误会要求核查原目标图格，不会误报成功。

### 真实业务与受控fixture的边界

- 使用Ubuntu独立PG14、API及各worker，来源为真实OANDA Practice Bid。EURUSD自建历史真实发布，固定版本
  `0341a05c-0c7e-434d-980a-4e9550d0c1f5`；此前实际M1观测2043根。GBPUSD由UI真实创建并等待发布，随后实际打开主图。
- 映射保存、显式组合使用、配置、维护、引用保护、归档和回收调用真实API。未用UI fixture替代价格或供应商发布。
- 网络初次失败、丢失响应、超时、迟到响应和首次保存409通过浏览器路由故障注入；真实提交仍由隔离API持久化。
- 长文本、空列表、无工作区列表及组合25行仅为布局/导航fixture。无工作区fixture只改GET返回，后续创建保存真实执行。
- 任务重试使用精确新建任务的PG失败状态注入，临时停止本project的history-worker，finally恢复；不修改其他任务或生产数据库。

### 真正200%浏览器缩放

通过临时MV3扩展的`chrome.tabs.setZoom(2)`设置Chrome真实缩放，逐档验证getZoom=2和DPR=2，
物理宽度1024/1440/1920对应CSS宽度512/720/960，且在缩放后reload验证桌面入口仍存在。
截图使用CDP `Page.captureScreenshot(fromSurface:false)`，保留完整物理窗口宽度；
早期CSS zoom只作为内容放大补充，不再作为真实浏览器200%证据。

| 物理宽度 | 自建列表截图 | 组合候选截图 |
| --- | --- | --- |
| 1024 | [自建](browser-zoom200-1024.png) | [组合](browser-zoom200-composite-1024.png) |
| 1440 | [自建](browser-zoom200-1440.png) | [组合](browser-zoom200-composite-1440.png) |
| 1920 | [自建](browser-zoom200-1920.png) | [组合](browser-zoom200-composite-1920.png) |

## 回归与审查

最终浏览器9套、45组场景均通过、pageerror为0；完整输出见[最终浏览器回归](final-regression.log)。
后端相关5文件33项通过，实际在Ubuntu本任务API镜像中运行，见[后端回归](backend-regression.log)；
只读挂载tests产生pytest缓存写入warning，不影响通过。桥接Node7项通过，见[桥接回归](bridge-regression.log)。
TypeScript及Vite生产构建、JS语法检查、`git diff --check`通过。Vite保留既有大chunk提示。
早期本机venv缺yfinance导致11项失败，转到依赖齐全的隔离API镜像后33项全部通过。

**Standards**：初审0项硬性违约，1项重复浏览器启动/登录/来源配置的判断项；已提取共享fixture。
最终追加复核0项硬性违约、0项需处理判断项。

**Spec**：原4项发现（异步应用后段过期校验、窄布局固定、真实200%证据、旧方案状态），
以及后续组合表格/筛选和遗留空面板遗漏，均已修正并复验。最终定向复核无未解决项。
审查使用[code-review技能](/home/quant/.agents/skills/code-review/SKILL.md)的Standards/Spec双轴流程；审查本身为源码核对，不替代运行结果。

额外收口发现：首次native save失败提前return使自定义工具栏未初始化。真实409注入先复现失败，
修复后保持初始化、草稿恢复及原始错误文字，原场景回归通过；未留下DEBUG探针。
早期真实zoom脚本还有native frame就绪和隐藏筛选按钮的寻址问题，均已修正，最终三档全通过。

## 实际环境、访问与启停

实际主机 `quant-server`，Ubuntu22.04，IP `192.168.7.232`，本机Docker socket。
独立task/project `mw-data-center-impl-20261008`；独立default网络、PG14数据卷`mw-data-center-impl-20261008_data-center-pg`，
独立数据库/用户`data_center`，端口19943和19944；从未使用unraid部署。
验收运行地址为 <https://192.168.7.232:19943/advanced-charts>，许可图表origin为 <https://192.168.7.232:19944>。
使用本机自签TLS；登录、env、私钥、许可库及完整浏览器状态均在ignored私有目录，未提交。

全部Market Watch构建经`mw-docker build`，显式task/project/acceptance，builder=`market-watch-ubuntu`。
验收实例最终镜像ID（web标签为0d1d53d+收口修复dirty树，frontend源码与1dc99d9一致；chart为1dc99d9）：

| 服务 | 实测镜像ID |
| --- | --- |
| API | `sha256:abc00eeffbe3ed33213a58b9bc104ce9cde38d7f6b92f329e3538312f3cb66a1` |
| web | `sha256:97bb37f574cbb04a4601b80d8fa31a1ff5483379e84aed0030956cca1f3049da` |
| chart-origin | `sha256:2c6c15382631bfb78c026c578f980b728156c51006c9e6aa5c2c53e856c35661` |

运行期间实际使用的启动/停止命令，在本worktree根执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center/compose.env -p mw-data-center-impl-20261008 -f artifacts/data-center/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center/compose.env -p mw-data-center-impl-20261008 -f artifacts/data-center/compose.yaml stop'
```

本任务结束按AGENTS要求精确退役：先`mw-docker retire --task mw-data-center-impl-20261008 --project mw-data-center-impl-20261008`预览，
再对同一归属清单`--apply`，先归档并实际恢复校验数据库，再删除本任务容器、网络、volume及无引用镜像。
2026-10-08 20:03（Asia/Singapore）实际完成退役；数据库83张表、149,894行的行数和内容指纹一致，来源稳定性复核通过。
最终状态和私有备份位置见[资源退役记录](retirement.json)。实测该project的容器、网络、volume及任务镜像剩余均为0。
退役后上述验收地址停用；历史启动命令不再能启动已删除资源。
后续运行需新task/project、新镜像tag及独立数据库/网络/volume/端口，通过`mw-docker build`重建；
私有Compose/env可从本机归档准备，数据库恢复使用已校验dump。生产发布仍需明确授权。
