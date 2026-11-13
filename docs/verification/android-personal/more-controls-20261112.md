# 更多页控件与布局打磨

分支 `feat/android-personal-v205`。按用户要求使用 `market-watch-mobile-ui`，复用现有 shadcn base-nova / Base UI。F0：兼容的前端控件与交互迁移，不改 API、schema 或持久格式。未跑 CI、未更新 PR。

## 完成范围

- 移除顶部重复的“更多”和“最近通信”。保留底部导航；连接状态与心跳收进连接详情。
- 品牌区使用网站实际白底 logo；设置分为“行情与数据”“通知与显示”“应用”，统一图标、文字、状态、箭头、分隔线及间距。普通设置行至少58px，退出登录独立弱化显示。
- 本页按钮使用 shadcn Button；连接、后台通知、更新、关于四个详情使用共享 Drawer；切服务器使用 AlertDialog，保留取消和返回层级。
- 更新检查/下载时禁用重复操作并反馈状态；服务刷新保留 busy 和错误反馈；通知面板退场后再打开事件记录。
- 将共享控件样式提炼到 `.mobile-controls`，自选与更多分别 opt-in，不给更多挂 `.mobile-watch`。保留原 Watch 导入兼容。
- 独立事件记录仍使用原模块，不宣称全 App 均已迁移。自选行情主体与业务保持本轮之前的实现。

[浅色前后对照](a07-feedback/more-controls/before-after.png) · [深色前后对照](a07-feedback/more-controls/before-after-dark.png) · [两轮打磨记录](a07-feedback/more-controls/polish-log.md)

## 验证

`npm run build`、`git diff --check` 通过。本地通过：

```sh
cd web
MOBILE_MORE_OUTPUT=/tmp/mw-more-final-verified node tests/mobile-more.browser.cjs
node tests/mobile-watch.browser.cjs
MOBILE_VISUAL_OUTPUT=/tmp/mw-more-watch-regression node tests/mobile-watch-a07.browser.cjs
node tests/mobile-app.browser.cjs
node tests/mobile-alerts.browser.cjs
```

更多页覆盖375/412px、深浅主题、150%字号、四详情开关和退场、主题切换、刷新 busy/错误、切服务器取消与顶层返回、通知→记录交接、模拟宿主更新检查/下载/完成、减少动态效果、离线状态与退出。详情和整页无水平溢出；自动化无页面错误。[夹具检查记录](a07-feedback/more-controls/fixture/proof.json)。

更新断言按语义核对“当前应用”对应的真实版本值，适配新版详情布局；没有取消版本验证。共享样式和弹层调整后，自选、图表及告警回归通过。

Ubuntu真实环境仅登录、读取、开关详情及切本地主题，未写真实偏好或行情数据，页面错误为零。[只读检查记录](a07-feedback/more-controls/live-after/proof.json)。旧版对照截图通过CSS切换主题，主题行的文字仍反映旧React状态；新版截图通过真实主题按钮切换，文字与外观一致。截图不作为行情几何验证。

浏览器夹具和Ubuntu验证不等于Android真机触感、实体返回键或系统键盘验收，需用户在手机体验。

## Ubuntu预览

实际运行主机 `quant-server`，既有隔离project `mw-android-personal-v205`，仅更新web，不涉及Unraid或其他实例。预检可用内存约7.1GiB、磁盘约13GiB。原有api/postgres/tls健康、data-worker运行；新web正常，HTTPS CA校验 `/readyz` 返回ready。

地址：<https://192.168.7.232:18445/m/>。手机“更多 → 检查更新”，无需重装APK。Shell `3321701cf1c6f3b8`。

通过 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:android-personal-v205-more-controls --task mw-android-personal-v205 --project mw-android-personal-v205 --purpose acceptance` 构建。

固定镜像 `sha256:d55ac889ac787e409f465263c8b902c2cf1a584dda8c830f9f78637748a97420`。旧镜像 `sha256:93044660c4904e5778411e130c6b6770c39d700d031f1b3aed00ec962069fc49` 保留，私有配置0600备份 `before-more-controls-run.json`。仅修改run.json的web镜像引用。

启动/更新：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同一命令参数，将最后一行改为 `stop web`。配置回退（未执行）：第一个配置改用同目录 `before-more-controls-run.json`，执行同样up命令；不动数据库。
