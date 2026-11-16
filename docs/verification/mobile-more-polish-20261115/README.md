# 更多页统一样式与打磨

2026-11-15，`feat/managed-live-rollover-20261113` 当前工作树。P0：局部手机 UI、展示状态与反馈调整，无后端、数据库、桌面页面或 APK 改动，保留此前未提交工作。

## 交付效果

- 与数据、告警页使用同一字体、主题、标题尺度、16px 边距和轻分隔线。移除旧卡片外框、图标底块与冗余的个人工作区/设备副标题，保留网站白底 logo。
- 入口收成“服务与通知”“应用”两组。整行触摸目标至少 60px；主题直接切换，不再显示误导为进入下一层的箭头，并提供正确的按下状态。
- 四个设置详情沿用现有 shadcn/Base UI Drawer 的圆角、标题、关闭、动效和返回处理。详情左侧名称、右侧状态，长服务器地址独立展示；关于页默认只显示版本，WebView/浏览器信息按需展开。
- 通知测试结果翻译为简短状态；时间使用本机时区的中文日期与 24 小时制，日期、时间各自保持完整，大字号可自然换行。
- 连接刷新错误与更新错误分开，避免连接失败被误认为“检查更新”失败。更新保留检查中/下载中禁用、网页更新入口和原生协议错误的就地反馈；普通运行消息仍进日志。

[修改前后对照](before-after.png) · [浅色实际页面](runtime/more-light-375-14.png) · [深色实际页面](runtime/more-dark-375-14.png)

## 两轮截图与验证

第一轮 [截图](round1/) 与 [检查记录](round1/proof.json)：完成轻列表、分区与抽屉统一；亲自查看浅色/深色、375px、150% 字号及展开详情，发现默认英文日期在大字号下形成孤立 PM。第二轮改为完整日期/24 小时组合，复查实际页面后收口。

最终验证：

- `cd web && npm run build`：通过，见 [构建记录](build.log)。
- `MOBILE_MORE_OUTPUT=../docs/verification/mobile-more-polish-20261115/round2 node tests/mobile-more.browser.cjs`：通过，68 张稳定截图，无页面异常。覆盖 375/412px、深浅主题、150% 字号、缩短视口；四个设置抽屉、环境信息展开/收起、主题、刷新忙碌/失败/重试、错误隔离、通知配置/投递状态、通知测试翻译、切服务器取消/返回、记录交接、原生更新状态、减少动态效果、离线、退出与日志搜索/详情/复制/脱敏导出。见 [流程证据](round2/proof.json)、[输出](round2.log)。
- 测试补充过程中修正两处验收假设：通知状态与 time 同在 dd，改按 dd 断言；现有 MobileApp 退出流程会先清除本地再异步撤销会话，不以失败后留在更多页作为预期。未修改既有退出语义。早期输出保留为 `round2-*-attempt.log`。
- `node docs/verification/mobile-more-polish-20261115/runtime-check.cjs`：Ubuntu 真实服务只读验证通过，35 张截图，无页面异常、无意外写入，见 [脚本](runtime-check.cjs)、[结果](runtime-proof.json)。包含普通浏览器完整 User-Agent 的折叠展示、短视口滚动及数据/告警页对照。认证后仅允许 GET；后台自选的读取/订阅 POST 被拦截并单独记为 blockedBackgroundReads，未发送到服务，不据此验证实时行情连接。
- `python3 docs/verification/mobile-more-polish-20261115/deployment-check.py`：APK 信任 CA 验证 HTTPS 通过，6 项手机资源、SW/manifest、`/readyz`、网页镜像和原 APK 下载只读挂载一致；更新清单 no-store、APK 大小/SHA-256 和缺失 APK 404 均通过。见 [部署检查](checks.json)。
- `git diff --check`：通过。布局已亲自查看两轮截图与部署后的实际截图；Android 真机手势、系统字号与物理返回仍需用户确认。

## Ubuntu 验收实例

实际主机：Ubuntu 本机 Docker，task/project `mw-managed-live-rollover-20261113`。已部署：

**https://192.168.7.232:18447/m/more**

仅替换 web，其他服务与数据不变。无需新 APK，可在“更多 → 检查更新”应用网页更新。版本、image 和备份 stamp 见 [部署记录](deployment.json)。本次未提交 commit、更新 PR、执行远程 CI、打正式 tag 或操作 Unraid。

构建通过 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:mobile-more-polish-20261115-r3 --task mw-managed-live-rollover-20261113 --project mw-managed-live-rollover-20261113 --purpose acceptance`，见 [最终 Docker 构建](docker-build-r3.log)。本机安装版工具的默认 web context 仍是 web/，与当前 Dockerfile 要求仓库根 context 不同，因此必须显式提供 `--context . --file web/Dockerfile`；未改工具或 Dockerfile。

启动/停止：

```bash
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

私有 `run.json`、`compose.json` 修改前已留存 `.before-mobile-more-polish-<stamp>`。回退时只将两者 web image 改回部署记录中的 previous image，再执行：

```bash
docker compose -p mw-managed-live-rollover-20261113 \
 -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json \
 up -d --no-build --no-deps web
```

不整体覆盖其他服务配置或数据库。
