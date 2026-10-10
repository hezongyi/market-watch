# 自建行情删除入口验收

2026-10-09，Asia/Singapore。基线 `be76323`，修改与本记录同提交。

## 问题与行为

原列表只有“查看”和“打开图表”。历史回收藏在详情的“组合与引用”，还需另到维护设置暂停、归档；后端原有归档命令不同时暂停维护。[修改前浏览器复现](delete-before.log) 因列表不存在“删除历史数据”入口失败。

列表和详情现提供“删除历史数据”，进入即读取并展示准确的版本、价格范围、周期及引用影响。仅打开或取消页面不提交数据命令，取消后恢复原列表筛选、页码和行焦点。

已配置维护的行情可在删除页点击“暂停维护并归档”：顺序执行既有暂停、归档命令，重新读取影响清单；归档从默认列表移除条目，价格仍保留。用户随后明确点击“删除所列数据”，携带最新清单修订和幂等请求标识，后端再检查引用与任务。防止重复点击；部分归档失败可重试；清单变化时取消旧确认并展示新引用。原组合管理入口、数据源身份和价格精度修改保留。

边界：删除回收无引用历史价格及周期数据，来源身份、发布清单和回收记录保留，“已归档”仍可查。图表使用租约、保存工作区、回测、组合及任务依赖继续阻止回收。没有历史价格时禁止提交删除。尚未配置维护的既有注册条目仍需先保存维护设置，本轮未新增无维护计划的归档后端接口，也未实现数据集身份的彻底删除。已有用户数据未被测试删除。

## 验证

| 范围 | 结果 |
| --- | --- |
| 真列表／详情入口、取消返回；暂停再归档、重复点击、最新清单确认、引用拦截、零目标、409 冲突、归档部分失败、详情重开及维护引导 | [浏览器报告](delete-report.json)，8 组通过，无页面错误 |
| 实际价格回收、幂等重试、身份清单保留、新维护版本、工作区／回测／任务保护、共享缓存保护、清单变化冲突 | Ubuntu 无网络临时测试容器及独立 SQLite fixtures，[日志](backend-tests.log)，12 项通过 |
| 原生弹窗一致性、图标位置和指标相邻关系、暗／亮色三种宽度、焦点、刷新 | [原生 UI 报告](native-ui-report.json)，7 组通过，无页面错误 |
| TypeScript、Vite、Ubuntu 专用 BuildKit 镜像构建、静态差异检查 | [构建日志](web-build.log)通过，仅既有分块大小提示；`git diff --check`通过 |

浏览器串行运行。真实列表／详情读取后，对选定数据集的破坏性命令拦截并模拟响应，其他数据写入一律拒绝；图表解析／报价批次读取继续正常执行。实际回收行为由独立后端 fixtures 验证。未运行旧项目的破坏性 lifecycle 浏览器脚本。界面截图 [delete-workflow.png](delete-workflow.png) 展示无维护计划的引导分支。

## 实际环境、地址与启停

Ubuntu 22.04 `quant-server`（`192.168.7.232`）本机 Docker；task/project `mw-data-center-review-20261008`，独立 Compose 网络、PG volume、数据库及 19943/19944 端口。使用 `mw-docker build --component web --task mw-data-center-review-20261008 --project mw-data-center-review-20261008 --purpose acceptance` 和 `market-watch-ubuntu` BuildKit。本轮只更新 web，未使用 unraid 或生产资源。

访问 <https://192.168.7.232:19943/advanced-charts>，图表 origin <https://192.168.7.232:19944>。密码保持不变，凭据、私钥、许可库及浏览器状态未提交。九个服务运行，API／PG 健康；镜像 ID、归属和状态见 [runtime.json](runtime.json)。验收实例保留，任务仍进行中，未退役或清理资源。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```
