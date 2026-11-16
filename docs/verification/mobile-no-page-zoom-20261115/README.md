# 手机端统一禁止页面缩放

2026-11-15，P0 局部视口配置修改。`web/m/index.html` 统一设置 `maximum-scale=1.0, user-scalable=no`，删除自选页随可见状态临时设置/恢复 viewport 的 effect。登录、自选、数据、告警、更多和图表共用同一手机入口；不修改桌面入口、专业图表内部手势或 Android 外壳。

## 验证

- 本地及 Ubuntu Docker 完整 Web 构建通过。
- `cd web && node tests/mobile-app.browser.cjs` 通过：登录、五导航、真实许可图表、20 次导航切换、布局恢复、离线缓存与更新生命周期，无页面错误；接口为显式夹具。
- 使用 APK 的开发 CA 实际验证 HTTPS：手机入口包含新 viewport，全部 6 项手机壳资源返回 200，SW 与 manifest 版本一致，`readyz` 200；下载更新清单 no-store，APK 字节数/SHA-256 一致，不存在的 APK 返回 404。
- 已核对网页容器实际 image ID，见 [部署记录](deployment.json) 与 [线上检查](checks.json)。浏览器模拟 pinch 的对照未成功产生缩放，因此不作为触摸验收证据；Android 真机仍需确认页面双指禁止放大且图表内部缩放正常。

## 部署

实际主机为 Ubuntu 本机 Docker，project `mw-managed-live-rollover-20261113`，访问 **https://192.168.7.232:18447/m/**。仅替换 web 服务，下载目录的原只读挂载保留；无需安装新 APK，在“更多 → 检查更新”应用网页更新。

启动/停止入口：

```bash
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

部署前已备份任务私有 `run.json` 与 `compose.json`，后缀为 `before-mobile-no-page-zoom-<stamp>`。回退时保留当前配置，仅将两个文件的 web image 改回部署记录的 previous 值，再对同 project 执行 `up -d --no-build --no-deps web`。不涉及数据库迁移、后台服务切换或 Unraid。
