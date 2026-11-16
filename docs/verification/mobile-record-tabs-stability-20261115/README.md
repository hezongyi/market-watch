# 告警记录切换按钮跳闪修复

2026-11-15，`feat/managed-live-rollover-20261113` 当前工作树。P0：只调整事件记录主抽屉的高度策略，保留其他未提交工作，不改变告警业务和请求逻辑。

## 原因与修正

原事件记录抽屉按内容自动计算高度。“触发 / 异常恢复 / 系统”内容高度不同，异步读取还会经历加载和返回结果两个高度，导致抽屉顶部及切换按钮一起跳动。首次失败复现三次垂直位移分别为 276.41、87.38、367.03px，见 [修复前逐帧数据](before/frames.json)。

先只在浏览器给此抽屉设置现有 `data-full-height` 做隔离探针，三次位移均降至 0，见 [探针数据](probe-fixed-height/frames.json)。因此 `RecordsSheet.tsx` 主抽屉启用现有 `fullHeight`：保持 84dvh 的稳定高度，内容在内部滚动。记录详情仍按内容适配高度，保留既有进出动效及返回逻辑，没有修改全局 Drawer。

## 检查

- `cd web && npm run build`：通过，保留 Vite 原有大包提示。
- `MOBILE_RECORD_TABS_OUTPUT=../docs/verification/mobile-record-tabs-stability-20261115/after node tests/mobile-record-tabs-stability.browser.cjs`：通过。[32 次逐帧检查](after/frames.json) 覆盖 375/412px、深浅主题、14/21px 根字号；慢查询、空态、有记录、再次读取缓存期间垂直位移全部为 **0px**，并验证 ARIA 面板对应、失败重试、嵌套详情返回及无横向溢出。实际构建页面和 API 夹具，动画开启，非真机验收。
- `mobile-more.browser.cjs`：通过，见 [日志](more.log)。覆盖主抽屉与其他设置抽屉的统一几何、控件、退出和通知交接、嵌套返回、大字号与短屏。
- `mobile-alerts.browser.cjs`：通过，见 [日志](alerts.log)。规则和触发记录流程、从告警页打开异常恢复及详情处理回归正常。
- [部署检查](checks.json)：可信 HTTPS、6 项手机资源、shell/SW 版本、readyz 和容器 image 一致；保留 APK 下载只读挂载，下载清单与 APK 大小/哈希和不存在地址 404 均通过。
- [真实实例只读脚本](runtime-check.cjs)：已登录后的浏览器写请求全部拦截，不创建规则、不处理告警；4 次真实接口切换的垂直位移均为 0px，无页面异常、无写请求，见 [runtime-proof.json](runtime-proof.json)。
- `git diff --check` 通过。

抽查了修复前后截图以及 150% 字号截图，已将逐帧截图保留在 before/after。浏览器截图和录帧不代表 Android 真机已验收。

## Ubuntu 验收实例

仅替换现有 **Ubuntu 本机 Docker** 项目的 web 服务，版本与回退 image 见 [deployment.json](deployment.json)。构建使用 `mw-docker build`，见 [docker-build.log](docker-build.log)。APK 0.1.4 下载挂载保留；本次为网页修复，无需重装 APK，通过“更多 → 检查更新”应用网页更新。

https://192.168.7.232:18447/m/more

启动/停止：

```sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

回退时仅将私有 run.json 和 compose.json 的 web image 改回 deployment.json 的 previous 值，再执行：

```sh
docker compose -p mw-managed-live-rollover-20261113 \
 -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json \
 up -d --no-build --no-deps web
```

配置原件私有备份为 `.before-record-tabs-<stamp>`。未运行远程 CI、更新 PR、提交 commit、打正式 tag 或部署 Unraid。
