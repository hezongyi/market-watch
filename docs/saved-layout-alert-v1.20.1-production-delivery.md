# v1.20.1 既有布局告警修复生产交付

2026-10-11。补丁 [PR #39](https://github.com/hezongyi/market-watch/pull/39) 已合并；不可移动附注标签 `v1.20.1` 指向 `89c5597032def55584e72c8cba0d221c3116383b` 并已推送。unraid 正式生产已从 v1.20.0 升为 v1.20.1，恢复既有布局时的原生告警初始化已验证。v1.20.0 标签与历史生产清单保持原样。

首次绑定图表活动事件先取消空订阅，真实许可库抛错并阻断告警接入。补丁记录实际订阅所属 widget，首次订阅、重复绑定和清理均幂等。真实许可库回归与 Ubuntu 独立 API/UI 五图布局恢复通过，两轴复核无阻断；来源与范围见 [补丁验收](verification/saved-layout-alert-v1.20.1/README.md)。

## 环境、地址与操作

实际生产为 unraid `192.168.7.33`，project `market-watch`，根目录 `/mnt/user/appdata/market-watch`，active-release `releases/v1.20.1-89c5597`。网站 **https://trade.kookvv.com:8443/**；图表来源 **https://charts.kookvv.com:8443/**。使用现有管理员密码，未修改密码；临时登录文件已删除，凭据未提交。

```bash
ssh unraid
cd /mnt/user/appdata/market-watch
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build
# 正式维护时停止本项目：
./tools/docker-compose -p market-watch -f compose.release.yaml stop
```

四类正式镜像从 clean `89c5597` 经 Ubuntu `mw-docker`、专用 BuildKit 构建，purpose=release。导入生产后 RootFS 与有效镜像配置匹配；Unraid 旧版 Docker 增补的空/default 配置字段已单独记录。固定镜像 ID 与逐服务 Settings 见 [生产清单](../deploy/releases/v1.20.1-production.json)。保留生产数据库、代理、OANDA stream 与其他投递配置，11 个后端服务（含 migrate）保持 Yahoo 启用；没有 schema 或依赖变化。

## 切换与验证

写入从 02:37:44 UTC 暂停，02:43:31 UTC 正式启动完成，共 347 秒。最终 dump 489,998,480 字节，在 Ubuntu 独立 PG14 实际恢复，86 表计数和告警、工作区完整指纹及账号/通知设置一致；临时恢复库已删除。配置归档中的 env、Compose 与 active-release 三项实际解包匹配，解包目录已清理。备份保存在原生产正式备份目录，未恢复或覆盖生产数据库。

- 12 个常驻服务正常运行，无重启，API healthy/ready，安装版本 1.20.1，两个 HTTPS 入口 200。
- Ubuntu Chromium 登录现有生产工作区，真实五图布局、行情 SSE 与唯一告警业务根就绪；告警侧栏/创建窗口、消息取消及通知 Esc 焦点恢复通过。数据中心六入口与来源状态真实读取、指标窗口共存、390px 主页无横向溢出通过，退出登录已核验。0 页面异常、HTTP 错误或图表域凭据泄漏。
- 生产浏览器检查为只读：偏好迁移响应固定为 migrated=0，自动 `widgetbar.layout-settings` 保存被 abort，其他业务写入阻止。首次 runner 因该自动保存尝试未过严格断言；明确该边界后复验六组通过，保存未送到生产。未保存告警、修改布局/偏好或投递真实通知。浏览器结束后用户状态指纹与备份基线仍完全一致。
- Yahoo AAPL 实际上游 D1 返回 27 根，最近报价 336.64、quote_time `1791576000000`；发布时为周末，不视为实时交易报价。
- 行情与通知心跳新鲜，但近期仍有 `market_error`：BTCUSDT SSL 失败及组合 EURUSD `Unknown source`。历史审计证明两类错误在本次切换前已存在，instrument 数量仍为 135。**不宣称全部行情供源健康或无后台错误**；未验证全部历史业务、下一次定时备份、真实手机响铃或长期稳定性。

详见 [登录态验收](verification/saved-layout-alert-v1.20.1/production/production-browser.json)、[运行身份](verification/saved-layout-alert-v1.20.1/production/runtime.json)、[数据库恢复](verification/saved-layout-alert-v1.20.1/production/database-restore.json)、[worker 边界](verification/saved-layout-alert-v1.20.1/production/worker-stability.json)。

## 回滚与清理

v1.20.0 镜像、配置与升级前正式备份保留，v1.18.0 原回滚点也保留。生产 `deploy/alert-init-v1.20.1-switch-20261011/rollback.sh` 只切回旧应用，保留当前数据和 Yahoo，不降 schema、不覆盖用户新增数据；回滚到 v1.20.0 会恢复其已知的既有布局告警初始化问题。

没有在 unraid 创建验收实例。Ubuntu 补丁验收与备份恢复 project 经 `mw-docker retire` 精确预览、备份及实际恢复后退役；首次因磁盘不足退役拒绝，核验归档副本后清理本轮临时归档并重试成功。生产本轮源码与镜像临时归档删除，正式备份和回滚资源保留，其他项目资源未处理。原 Ubuntu 用户验收实例仍保留。
