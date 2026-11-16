# 数据页实时开关放大

2026-11-14 用户要求直接调大自建列表实时开关。分类 P0：新增现有 shadcn/Base UI Switch 的可选 `lg` 尺寸，仅数据页列表启用；未改变默认尺寸、命令、禁用条件或行情业务语义。此前详情精简与两页搜索缓存提示仍为待实现，本次未实施。

## 变化与验证

- 可见轨道由默认根字号下约28×16px改为44×26px，滑块22px；外侧透明命中范围至少44px高，容器60×44px。调整容器右侧留白，保持触摸区域在列表内。
- `npm run build`、`git diff --check` 通过。已有数据工作流16组检查、56张截图通过，包括开关直接启停、不弹确认、失败回退、丢失响应核实、并发刷新及离线保护；写入仅针对明确HTTP夹具。见 [workflow-test.log](workflow-test.log)、[workflow-proof.json](workflow-proof.json)。
- Ubuntu真实实例375/412px、深浅主题、14/21px字号共8种布局：实际轨道44×26px、滑块22px、命中高度44px，透明扩展区域命中同一开关，无横向溢出，浏览器无异常。只读验证，未切换用户真实行情开关或修改用户自选；见 [runtime-proof.json](runtime-proof.json)。
- 人工查看调整前截图和最终实际浅色/深色大字号，以及夹具启用状态截图。真实已有不支持实时的品种仍灰显，运行状态根据接口原样展示。
- 部署后网页资源摘要与本次构建一致；APK更新清单200、0.1.3安装包大小与SHA-256一致。未构建新APK，实际Android触感待用户复核。

截图：[实际浅色](screenshots/data-light-412-14.png)、[实际深色大字号](screenshots/data-dark-375-21.png)、[夹具启用状态](screenshots/fixture-enabled-switch.png)。

## Ubuntu验收与回退

- 实际主机：Ubuntu quant-server本机Docker；复用本任务隔离project `mw-managed-live-rollover-20261113`，未新建数据库或改其他任务服务。部署前检查磁盘41GiB可用、内存约4.9GiB available；本次仅构建及替换web。
- 地址：<https://192.168.7.232:18447/m/data>。
- 启动：`/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh`。
- 停止：`/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh`。
- web镜像：`sha256:a6eff5d542f9bde89cf3a1549781ce76286f6d613ea69330d20f206225daf6f1`；shell：`14dd2511ec2269f2`。使用 `mw-docker build`，标签 `market-watch-web:mobile-live-switch-20261114`，task/project保持本任务归属，purpose为acceptance。
- 私有目录的 `run.json` 与 `compose.json` 已留存 `*.before-live-switch-<UTC>` 备份；只更新web镜像，APK downloads只读挂载完整保留。API、worker、数据库未变。
- 回退时使用本次配置备份恢复web旧镜像 `sha256:89fd8eb1160485e171a9eb1cd867341aac24c3f1668698189eb39a1c7eb72e95`，仅对本project执行 `up -d --no-build --no-deps web`，不需回滚数据库。旧镜像保留。
- 未执行PR/CI、commit、正式tag或Unraid生产操作，18443未修改。

后续：详情精简及搜索提示移除已实施，当前 API/web 镜像与 shell 以[最新验收记录](../mobile-detail-simplification-20261114/README.md)为准。本文为开关放大时的历史快照。
