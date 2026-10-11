# v1.20.0 原生图表告警生产交付

2026-10-11。PR #38 已合并，附注 tag `v1.20.0` 已推送，指向 main 合并提交 `73356b7983e21c9da313e75075672378bae760ef`。unraid 正式生产已从 v1.18.0 切换到 v1.20.0，包含 v1.18.1 历史价格精度修复及 v1.19.0 商品状态、报价和日历功能。

## 发布来源与实际环境

原生告警最终受测应用源码为 `c77f67c`，修复及独立两轴复核见 [PR #38 验收](verification/native-alert-ui/review-fixes/README.md)。发布整理仅更改版本及证据，保护的实现源码摘要均匹配。四类正式镜像在 Ubuntu `quant-server` 经 `mw-docker`、专用 `market-watch-ubuntu` BuildKit 构建，task `mw-native-alert-v1200-release-20261011` / project `mw-v1200-release-build` / purpose `release`，全部记录 clean `73356b7`。

四类镜像导入 unraid 后再次核对完整 RootFS、镜像配置及标签。生产 standalone Compose 从 `compose.production.yaml` 生成，固定实际镜像 ID，保留原有私密 env、代理、服务、网络、端口及数据库配置。全部 11 个后端服务（含 migrate）明确保持 `ALERTS_YAHOO_ENABLED=true`。API 与 pricing-worker 的 OANDA stream 保持启用，数据库 pool=2 / overflow=0，其他服务投递设置保持原值。

实际主机为 unraid `192.168.7.33`，project `market-watch`，根目录 `/mnt/user/appdata/market-watch`，active-release `releases/v1.20.0-73356b7`。固定镜像及逐服务证据见 [生产清单](../deploy/releases/v1.20.0-production.json) 与 [standalone Compose](../deploy/releases/v1.20.0-production.yaml)。

网站：**https://trade.kookvv.com:8443/**；隔离图表来源：**https://charts.kookvv.com:8443/**。登录沿用生产现有管理员密码，本次没有修改密码。

```bash
ssh unraid
cd /mnt/user/appdata/market-watch
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build
# 正式维护时停止本项目：
./tools/docker-compose -p market-watch -f compose.release.yaml stop
```

## 备份、切换与验证

第一次发布前只读 snapshot 因私密 bind mount 的目录权限无法读取，脚本自动恢复 v1.18.0；未换生产镜像或恢复数据库。核验脚本改为标准输入，预检通过后重新生成最终备份。第二轮停止本项目写入时间为 01:53:42 UTC，正式启动完成 01:59:14 UTC，暂停 332 秒。

最终 PG14 dump 为 489,953,730 字节，在 Ubuntu 独立 project `mw-v1200-restore-20261011` 实际恢复，86 张表计数及告警、工作区完整指纹一致，账号及通知设置也匹配。私密配置归档在 Ubuntu 实际解包，env 与原生产一致，回滚 Compose 逐字节匹配。生产迁移保持 `ar45_market_stream`，启动新应用前再次核对全部 86 表，仅允许备份成功新增的一条 audit。详见 [数据库恢复](verification/native-alert-v1.20.0-production/database-restore.json)、[配置恢复](verification/native-alert-v1.20.0-production/configuration-restore.json)、[切换记录](verification/native-alert-v1.20.0-production/switch-result.json)。

上线后验证：

- 12 个常驻服务运行，无异常重启；API healthy / ready，实际安装版本 1.20.0。逐服务镜像均匹配发布清单。
- 工作区、偏好、自选表、告警及其版本/操作完整指纹不变；账号与通知设置不变，没有新增密码修改或通知测试事件。
- API 及 9 个 worker 的实际 Settings 均启用 Yahoo 且保留代理。Yahoo AAPL 真实上游读取成功：D1 返回 27 根，报价 336.64，quote_time `1791576000000`。这是供应商最近报价，发布时为周末，不声称实时交易报价。
- 行情与通知心跳保持新鲜，发布进度继续更新；复查窗口未新增 error 类 audit。观察结果见 [worker 记录](verification/native-alert-v1.20.0-production/worker-stability.json)。
- 两个外部 HTTPS 入口均 HTTP 200；Ubuntu Chromium 验证生产登录页、390px 无横向溢出、图表 CSP `connect-src 'none'` 及图表域不暴露 API，0 页面异常。

**用户提供现有密码后，生产登录成功，但既有五图布局的原生告警初始化失败。** 两次新浏览器会话均在首次 `activeChartChanged` 取消订阅抛错；图表、行情和数据中心已就绪，`alertUI` 尚未初始化。此前 Ubuntu 新建工作区验收未覆盖该恢复路径。真实许可库最小回归已复现，补丁 v1.20.1 正在处理；不将本次生产 UI 宣称验收通过。只读检查阻止偏好迁移与业务保存，已退出登录；12 个服务、HTTPS 和用户状态指纹复查通过。也未重新验证全部历史版本业务、下一次定时备份、真实手机响铃或长期稳定性。具体结果见 [运行身份](verification/native-alert-v1.20.0-production/runtime.json)、[Yahoo 读取](verification/native-alert-v1.20.0-production/yahoo-production.json)、[公开页面](verification/native-alert-v1.20.0-production/production-public-browser.json)、[登录态结果](verification/native-alert-v1.20.0-production/authenticated-browser-status.json)。

## 回滚与清理

v1.18.0 四类生产镜像、原 standalone 配置、active-release 及升级前备份保留。回滚脚本位于生产 `deploy/native-alert-v1.20.0-switch-20261011/rollback.sh`，只停止本项目并切回旧应用，保持当前数据和 Yahoo 启用，不自动降级 schema 或覆盖新增用户数据。回滚后需重新核验健康、供源和 worker。

本次没有在 unraid 创建验收/测试实例。Ubuntu 恢复实例经 `mw-docker retire` 预览、备份及实际恢复核对后精确退役，私密配置解包目录已移除。生产本次两个临时发布归档及成功迁移容器已按精确名称删除，旧回滚点和数据库备份保留；每日 03:00 备份 cron 保持原配置。原生告警 Ubuntu 用户验收实例继续保留，没有标记其验收结束。

凭据、env、私钥、数据库 dump、许可库及完整私密配置归档均未提交 Git。后续生产证据提交只更新文档，不移动 v1.20.0 tag。
