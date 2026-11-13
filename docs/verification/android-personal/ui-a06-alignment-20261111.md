# A06 界面复刻：首轮主页面调整，完整覆盖未完成

当前不能作为“所有页面与状态已复刻完成”的交付记录。下面的通过结果仅覆盖所列检查；功能测试通过不等于冻结稿视觉验收通过。

本轮为 P0 呈现层调整：页面结构、字体、间距、列表列宽、设置弹层和现有告警操作入口；没有修改 API、数据库格式、桌面布局或手机缓存格式。按用户要求暂不提交分支、不更新 PR、不触发 CI。

依据：`docs/android-ui-freeze-a02-20261111.md`、A06 原型源码及页面截图，另参考用户放在 Unraid Studio 根目录的 `Screenshot_2026-11-11-19-58-09-53_bf9c6e545ee4bfd4340a0323cc28c9fd.jpg`。从 Unraid 只读取这张图片，没有部署或修改该主机。

## 已调整

- 自选：恢复 14px 根字号对应的 A06 尺寸；长报价说明改用简短名称与来源/系列，完整说明保留在标题信息中；长代码适当加宽身份列，价格保持单行；按实际涨跌着色，缓存状态仍灰显；标题/SSE 随可用空间换行。
- 告警：还原监控概况卡、三项统计、横向筛选、规则卡及底部详情/暂停入口；统计依据服务端 execution，准备中不会被计为监控中。记录弹层独立于一级页，更多页面打开记录不会显示另一个一级页。
- 数据：默认平台目录、下划线标签、搜索框、紧凑来源栏和“任务与来源”弹层；详情卡保持真实身份、实际周期和加入自选能力。
- 更多：资料头与三组设置行，连接、通知和版本说明移入弹层；原有退出和换服务器仍可达。
- 底部导航：五个入口及图标背后的圆角选中态；图表外层工具栏使用透明图标按钮，保留真实专业图表。

## 本地验证

`web/` 下 `npm run build` 通过。使用本机已安装的 Chromium 执行以下脚本均通过：

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node tests/mobile-visual.browser.cjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node tests/mobile-watch.browser.cjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node tests/mobile-alerts.browser.cjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node tests/mobile-app.browser.cjs
```

视觉脚本含长代码/名称/来源、360/375/412 宽、150% 字体、横屏及 412 宽浅色截图；无横向溢出或页面异常。正常尺寸长身份行约 118px，价格单行。其余脚本验证自选分组、重连、迟到搜索、409 输入保留、告警提交与状态操作、真实注册指标目录、参数取消与本地恢复等。它们使用显式 API fixture，不代表手机验收。

## 实际运行环境

- 主机：Ubuntu `192.168.7.232` 本机 Docker。
- Task / Compose project：`mw-android-personal-v205`；沿用任务独立 PG、volume 和网络。
- 地址：`https://192.168.7.232:18445/m/`。
- Web 镜像 manifest：`sha256:edb02835ae29c945e23258874ca81b3afd582e0aea5fba74a0fe8f2b233b71f3`。
- 手机网页构建：`1a2a66f8694e20a6`。APK 壳未修改，现有安装可以加载新版页面。

从仓库根目录启动/停止：

```bash
python3 deploy/ubuntu/mw_docker.py preview up --task mw-android-personal-v205 --project mw-android-personal-v205
python3 deploy/ubuntu/mw_docker.py preview stop --task mw-android-personal-v205 --project mw-android-personal-v205
```

真实隔离后端检查通过：HTTPS 登录、自选、目录筛选、设置弹层及原生图表/指标入口。真实任务数据中的 `D1_BTCUSDT` 行高 `117.890625px`、`D1_EURUSD` 行高 `100px`，价格均单行。后者原有品种不可用状态仍据实显示。当前任务库为 D1 合成数据；截图和这些检查不是供应商实时行情或手机实收通知证据。

日志和截图留在本机 `/tmp/mw-mobile-a06-*.log`、`/tmp/mw-mobile-a06-*.json`、`/tmp/mw-a06-real-ui.json`、`/tmp/mw-a06-real-ui/`、`/tmp/mw-mobile-visual/`。

## 尚未完成的视觉覆盖

以下是代码与现有视觉脚本核对结果，不代表这些功能完全没有实现；它们尚未完成本轮冻结稿逐项复刻和截图验收。

| 页面 / 状态 | 当前证据与剩余工作 |
| --- | --- |
| 自选、告警、数据、更多常态 | 已做首轮结构和样式调整；已有视口截图，仍需逐项与冻结稿对照 |
| 专业图表 | 保留真实组件；外部工具栏已调整，触屏、原生参数与安全区仍需真机验收 |
| 登录 / 服务器配置 | 登录仍为原有简单表单；原生服务器配置未做本轮完整视觉对照 |
| 搜索品种 | 自选添加入口仍跳转数据页，尚未还原独立搜索弹层 |
| 分组 / 自选管理 | 功能回归通过；分组选择、创建、改名、排序、移除与撤销尚缺完整视觉对照 |
| 告警创建 / 编辑 / 详情 | `PriceRuleSheet.tsx` 本轮未调整；表单层级、条件控件、详情信息与操作布局待对照 |
| 触发 / 异常 / 恢复记录及详情 | `RecordsSheet.tsx` 本轮未调整；待对照列表、详情、确认与投递事实展示 |
| 数据详情 / 历史版本 / 维护与来源 | 功能可达；弹层信息层级、周期、操作区及来源状态待完整对照 |
| 无缓存加载 | 自选、告警、数据及初始会话仍有普通文字占位，骨架尚未按冻结稿补齐 |
| 空列表 / 离线无缓存 | 仍有普通段落提示，待还原冻结稿空态与可用操作 |
| 缓存刷新 / 离线有缓存 / 单行陈旧 | 已有缓存与灰显逻辑、部分回归；缺各页面逐状态截图验收 |
| 提交中 / 失败 / 结果未知 / 409 | 已有行为回归；浮窗、未保存标记、核查与保留输入尚未全部视觉对照 |
| 字段错误 / 会话过期 / 无能力 / ntfy 未配置 / IDB 失败 | 已有部分逻辑；尚未形成完整状态截图矩阵 |
| 深浅色 / 150% 字体 / 横屏 / 软键盘 | 当前脚本覆盖主页面的部分组合，未覆盖所有弹层和状态；系统栏与 WebView 需真机 |

## 下一步

先补齐上述页面与状态，按冻结稿完成同尺寸截图对照，再请用户协助 Find X8 真机验收并根据截图调整。现有 Ubuntu 地址和 APK 只供查看当前阶段成果，不表示完整视觉验收已就绪。用户确认完成后再更新 PR；当前不触发 CI。
