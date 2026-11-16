# 手机分页左右滑动

> 后续已改为 shadcn Carousel / Embla 跟手动效，见 [新版验收记录](../mobile-tab-motion-20261116/README.md)。下文保留首版按阈值切页的历史记录。

2026-11-16，`feat/managed-live-rollover-20261113` 当前工作树。F0：兼容的手机 UI 手势增强，采用本地构建、明确 HTTP 夹具与 Ubuntu R1 实例只读验收。保留分支此前未提交修改。

支持数据分类、告警规则/记录、事件记录的触发/异常恢复/系统、管理自选的品种/分组。内容区左滑下一页、右滑上一页，首尾不循环；点击、键盘、分类栏横向滚动和现有读取/缓存/滚动位置语义保留。未改底部主导航或图表手势。

共享 Tabs 以 `swipe` 显式启用 `useSwipeTabs.ts`。12px 后锁定方向，横向必须明显大于纵向；切页阈值按宽度取 48–72px，纵向起手后不再转为切页。多指、取消、24px 屏幕边缘、输入框、实时开关、内嵌横向滚动区不接管；横拖后抑制触摸兼容 click，防止误开条目。复用已有 Tab 激活，不另维护分页状态或预加载面板。

首次原生触摸测试发现 Drawer 在 document capture 阶段先认领事件，使抽屉横滑无效。使用 Base UI 已提供的 `data-base-ui-swipe-ignore="x"` 交由官方按轴仲裁，保留竖向关闭和确认逻辑。没有修改 Drawer 源码或阈值。

验证通过：

- [完整本地构建](build.log)、[Docker 构建](docker-build-r2.log)；TypeScript、Vite、专业图表与手机壳通过。首轮 Docker 命令误用了组件默认 context；改为显式仓库根 context 后成功，见保留的首轮日志。
- [数据分类](data/proof.json)：13 组检查、30 张截图。CDP 实际触摸验证左右切页、首尾、短滑/斜滑、多指/取消/边缘/纵向锁定、点击键盘替代；分类分页、位置保留、下拉刷新、失败恢复、离线以及 375/412px、深浅主题、150% 字号通过。
- [告警及下拉刷新](alerts.log)：含规则/记录和事件抽屉实际触摸切页，完整原有规则创建/编辑/冲突/归档/记录处理夹具回归通过，无页面错误。
- [自选管理](watch.log)：实际触摸切换品种/分组，不误操作、不保存；已有排序、删除草稿、丢弃确认、连接生命周期通过。
- [记录栏稳定性](record-stability/frames.json)：32 次切页逐帧检查，切换栏垂直位移均为 0px。
- [真实实例](runtime-proof.json)：全部实际分类滑动可达，8 组宽度/主题/字号组合，减少动态效果、告警分页、事件抽屉和管理自选通过。11 张截图已抽查；无页面错误、无业务写请求。真实数据仅做读取，业务写操作仅在 HTTP 夹具中。
- [部署检查](checks.json)：使用 APK 信任的开发 CA 核对 HTTPS、6 项资源、shell/SW 版本、readyz、容器镜像与只读 APK 下载挂载。下载清单、大小及 SHA256 校验通过。`git diff --check` 通过。

这些是浏览器触摸与截图验收；Android 真机上的滑动手感、系统边缘返回仍由用户确认。无新依赖、后端/数据库更改、远程 CI、PR、commit、正式 tag 或 Unraid 操作。

运行于 **Ubuntu 本机 Docker**，复用当前任务独立 project `mw-managed-live-rollover-20261113`，只更新 web，镜像与回退引用见 [deployment.json](deployment.json)。地址：**https://192.168.7.232:18447/m/data**。已安装 APK 无需重装，可通过“更多 → 检查更新”应用网页更新。

启动/停止：

```sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

回退时保留配置，将私有 run.json/compose.json 的 web image 改回 deployment.json 的 previous，仅运行：

```sh
docker compose -p mw-managed-live-rollover-20261113 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json \
  up -d --no-build --no-deps web
```

私有配置备份：任务目录 `mobile-tab-swipe-20261116-backup/`。没有迁移，不回退或删除数据卷。
