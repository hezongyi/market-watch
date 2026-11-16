# 添加自选 / 添加自建：按需展开搜索筛选

2026-11-15，`feat/managed-live-rollover-20261113` 当前工作树。P0：手机端局部 UI 与已有查询参数接入，无后端、数据库或网页端改动，保留此前未提交工作。

## 交互与实现

- 两个添加抽屉的关闭按钮左侧增加共用“增强搜索”纯图标按钮；默认收起，仅显示原搜索框与列表。沿用 shadcn/Base UI 的 Button、Collapsible、FieldGroup、MobileSelect、Drawer。
- 主动展开后显示来源、品种分类；常规字号并排，大字号自动纵向排列。选择条件自动更新结果，沿用 250ms 防抖；展开与收起本身不请求目录。
- 生效时图标变强调色并加轻量圆点；输入下方一行显示所选条件。收起保留条件；纯叉图标一键清除筛选，保留搜索词。未选择时不增加空白占位。
- 来源支持既有六个接入通道，并可按新浪财经、腾讯财经、东方财富限定上游。一般来源用已有 `source`，上游用已有 AKShare 来源 + 移动端上游关键词搜索。分类用原生/创建目录 `symbol_type`，自建目录对应 `asset_class`，全部在服务端过滤后分页。预留上游组合词空间，两个添加入口输入上限为 90 字符，总请求不超过既有 100 字符搜索上限。
- 两个搜索缓存与分页键包含筛选条件。变更条件取消旧请求并从第一页开始；后续页保留筛选。详情/创建返回保留条件与已加载列表；关闭整个添加抽屉后重开恢复默认简洁状态。创建设置时隐藏增强入口。
- 自选仍合并原生/自建，默认加入当前组，已添加条目本次打开期间保留勾选且禁用，重开后排除；添加自建仍只搜索可维护原生品种，排除已创建品种。
- 原有告警记录筛选继续独立保留在 `filters` 槽，新的折叠条件使用 `enhancedFilters` 槽，不改变告警记录筛选布局。

## 验证

- `cd web && npm run build` 通过，见 [构建记录](build.log)。
- `MOBILE_SEARCH_OUTPUT=../docs/verification/mobile-enhanced-symbol-search-20261115/fixtures node tests/mobile-symbol-search.browser.cjs` 通过，见 [搜索流程](fixtures.log)：双目录独立分页、真实身份去重、添加行为、失败重试、迟到响应、返回/关闭、缓存/离线；新增默认收起、来源/分类与后续分页、上游来源、空态、清除保留关键词、收起不查询、返回保留条件、关闭重置。共 29 张截图，含两入口 × 375/412px × 深浅主题 × 14/21px 字号及缩短视口。
- `MOBILE_ALERT_OUTPUT=../docs/verification/mobile-enhanced-symbol-search-20261115/alerts-regression node tests/mobile-alerts.browser.cjs` 通过，见 [告警回归](alerts-regression.log)，无页面错误。
- Ubuntu 真实目录只读验证见 [脚本](runtime-check.cjs) 与 [记录](runtime-proof.json)：Dukas 股票均为对应来源/资产类别；新浪和腾讯上游无串源；创建目录的腾讯股票本实例为零条，作为空结果，不以原生可关注能力推断可创建能力。两入口的深浅主题、大小字号、短视口共 24 张截图，已查看实际截图。
- 真实验证仅允许目录 GET，后台 watch 的 quotes/sparklines/resolve/subscribe POST 读取在浏览器拦截并单独记录为 `blockedBackgroundReads`，未发送到服务；任何其他非 GET 都作为意外写入阻断并使验证失败。认证会话使用任务私有凭据；无用户配置或行情写入。此次不据此验证后台行情连接或实时供源。
- [部署检查](checks.json)：APK 同一 CA 校验通过，shell/SW 版本一致，6 个网页资源和 `/readyz` 均 200，web 实际运行镜像匹配，APK downloads 原只读挂载保留。`git diff --check` 通过。
- 浏览器验证覆盖缩短视口和聚焦输入，Android 真机软键盘、手势与返回体验仍由用户验收。

## 验收部署

实际运行主机：Ubuntu 本机 Docker，task/project `mw-managed-live-rollover-20261113`。仅替换 web；API、worker、数据库及其他实例保持。访问：

- 自选：**https://192.168.7.232:18447/m/watch**
- 数据：**https://192.168.7.232:18447/m/data**

无需新 APK，通过“更多 → 检查更新”应用网页更新。新旧 image 与配置备份 stamp 见 [部署记录](deployment.json)；构建使用 `mw-docker build`，见 [Docker 构建](docker-build.log)。本次未更新 PR、执行远程 CI、提交 commit、打正式 tag 或操作 Unraid。

启动/停止：

```bash
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

私有 `run.json` / `compose.json` 修改前已留存 `.before-mobile-enhanced-symbol-search-<stamp>`。需要回退时只将两个配置的 web image 改回部署记录中的 previous image，对本 project 执行 `up -d --no-build --no-deps web`；不整体覆盖其他服务或数据库配置。
