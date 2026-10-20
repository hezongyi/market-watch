# 工具栏入口与模板顺序补验

用户在人工验收时反馈系统消息入口没有相邻图标的悬停反馈、左侧间距偏大；随后要求将指标模板放在指标之后，并启用验收实例 Yahoo 源。

风险 F0：原生 UI 适配及现有配置开关，无 schema 或持久格式变更。最小检查为原生组件本地验证、Web 与原生 bundle 构建、Ubuntu R1 页面复验及 PR CI。**候选 `c53abdf` 已更新长期验收实例，Playwriter 页面复验和Yahoo真实读取通过；最新归档提交CI以PR checks为准。**

## 已确认的原因与修改

此前 Playwriter 在实际验收页读取的系统消息入口是 `createButton({useTradingViewStyle:false})` 创建的 div，未挂载原生工具栏按钮。CSS 将其固定为52px；相邻原生按钮宽38px，入口前的分隔容器仍占9px。实测两个图标中心距离54px，相邻普通图标为38px。原有适配器仅允许键盘导航，入口无原生交互类或 hover 规则。该次自动化浏览器的 hover 媒体查询为false，不能把它的悬停截图作为桌面鼠标绘制效果的完整验证。

现在在公共 API 的占位容器中挂载固定版本图表库导出的 `ToolbarIconButton`（模块51061）。实际渲染为原生 button，具有 `button-GwQQdU8S` 和 `isInteractive-GwQQdU8S`；悬停颜色及背景由原生 CSS 提供。容器改为38px并去掉自身padding，入口前的整个分隔容器隐藏。角标保留，文字同步更新原生tooltip。业务点击与键盘处理沿用现有控制器。

指标模板保留原生实例和菜单，使用工具栏组的flex order放到现有指标入口之后；同步处理测量工具栏与重建，释放时恢复原有order和分隔样式。没有移动React持有的DOM节点。

## 本地验证

- `npm run build`、最终 `tsc -b`、`node scripts/build-alert-ui.mjs /tmp/mw-toolbar-alert-ui-20261020` 通过。首次原生bundle命令从仓库根目录运行，因相对入口路径失败；从web目录重跑通过。
- 原生模块渲染、点击单次触发、释放、模板在普通/测量/重建工具栏的顺序及释放恢复均通过，见[结果](local-native-result.json)。该检查使用JSDOM和本机许可库的真实组件；不证明浏览器布局、hover绘制或实例已更新。
- `node tests/native-chunk-recovery.cjs`、`node tests/native-preference-notice.cjs`（web目录）通过；`git diff --check`通过。

复现本地模块检查：

```bash
MW_JSDOM_PATH=/tmp/mw-jsdom/node_modules/jsdom node docs/verification/toolbar-followup-20261020/local-native-check.cjs
```

## Yahoo与运行核验

只读检查实例现有私有 `integrated-compose.json`：API、全部worker、projector及migrate的 `ALERTS_YAHOO_ENABLED` 已为字符串 `true`，代理配置存在。此前候选override没有覆盖该开关。提权后逐容器确认全部11个运行后端的开关为true，并核对实际Settings。目录API检索AAPL返回200、available=true；通过现有代理调用生产Yahoo适配器读取AAPL元数据和报价，返回status=ok、price=342.94、fetched_at=1792500826857。Yahoo本来已启用，因此没有反复重启后端或改写开关。见[核验结果](yahoo-results.json)，没有输出代理内容或其他私有配置。供应商的quote_time保留原值，不把本次读取当成全天新鲜度保证。

接续时执行沙箱曾拒绝Docker socket、Playwriter和外网连接；用户随后明确提权，连接恢复。此前归档CI `39417146466`已重新确认success。以下是提权后的真实结果，取代先前待验证状态。

## Ubuntu与Playwriter实机结果

主机 `quant-server`、Compose `mw-issue75-v2-20261018`，入口 `https://192.168.7.232:18280/advanced-charts/mw75-real?panel=notifications`。使用安装版mw-docker及原market-watch-ubuntu builder构建c3/c4；c3实测发现原生按钮随20px SVG收缩到30px，最终c4显式固定38px点击区域。实际Chart/Web来源 `c53abdf`，仅重建这两个应用服务。15服务运行，API/PG healthy；其余13个容器ID、全部环境和挂载内容与更新前相同。Mounts列表忽略Docker inspect非确定的数组顺序，比较完整对象。未执行迁移、seed或数据清理。见[运行审计](running-audit.json)。

| 组件 | 镜像 | Docker image ID |
| --- | --- | --- |
| Chart | `market-watch-chart:toolbar-20261020-c4` | `sha256:5b52fd9d36f24c5657c11a4bb8a91b77a42764b7cf86a15da5a3c9ce317f54b6` |
| Web | `market-watch-web:toolbar-20261020-c4` | `sha256:3b2e7705b107daadb58cf232d7932f7a4923ad15015aeeaabe2dea4ea128e85e` |

原长期浏览器保持原现场；使用自己的既有工作区和额外的任务临时浏览器，经Playwriter登录复验。临时浏览器声明真实桌面pointer/hover能力，未更改保护浏览器的启动参数或存储。实际结果见[browser-results.json](browser-results.json)：

- 浅色hover背景rgb(242,242,242)，深色rgb(46,46,46)，系统消息与设置一致。
- 原生按钮38px、前方间隙0、两图标中心距38px，分隔容器宽0；原为54px中心距。
- 指标模板左边界与指标右边界相等，原生菜单正常打开和关闭。
- Enter及Space打开，Escape关闭且焦点回入口；0/1/120本地合成未读数对应隐藏/1/99+，没有服务端写入，随后恢复真实状态。
- 760px深色窄屏可操作，原生布局存在约0.22px舍入，未产生横向页面溢出；刷新后只有一个入口且顺序保留。页面错误为空。

实拍：[浅色hover](light-hover.png)、[深色hover](dark-hover.png)、[指标/模板顺序](indicator-template-order.png)、[真实未读角标](unread-badge.png)、[深色窄屏](dark-narrow.png)。角标截图前合成数已被真实状态更新覆盖，截图展示真实未读数；合成0/1/99+的断言记录在JSON中。

当前应用启动/状态仍使用 `/home/quant/repos/.mw-notification-batch-20261020/operate.py start|status`。本轮仅Chart/Web回退至c2的私有overlay：`/home/quant/repos/.mw-notification-batch-20261020/toolbar-c2-rollback.json`；使用原base和该overlay，仅指定chart/web执行up --no-deps --no-build --pull never，不操作其他服务。旧完整批次回滚入口保留。

最新提交推送PR #87后检查CI；代码候选和文档提交分别固定，避免为回填每个CI结果重复提交。完整历史第13–21项证据继续保留。
