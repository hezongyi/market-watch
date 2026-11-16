# 自选英伟达名称不可用修复

2026-11-14。F0：报价错误返回兼容补全展示身份，无schema、价格、读取/预取策略或手机布局变更。

## 诊断和修复

用户反馈加入英伟达后名称不可用。首次只读检查时真实NVDA已恢复，显示NVDA／英伟达／Yahoo；不能据此断言用户当时的上游异常原因。以真实Yahoo目录、元信息和quote_snapshot调用链注入请求超时后，稳定复现两个缺陷：元信息未就绪或过期刷新失败时，错误行不含short_name；报价失败时description_base被错误提示覆盖。手机自选直接从报价读取身份，因此错误状态会连带丢失代码/名称/来源。

错误分支现在保留已取得的展示元信息；Yahoo元信息读取失败则只读本地已维护目录补全代码、名称和来源。该补全不需要远程请求、不参与行情身份或价格计算。错误状态、结构化错误证据和空价格保留；未知或禁用来源仍不可用。报价正常分支、sparkline、布局及订阅生命周期不变。

## 检查

- [修改前回归](backend-before.log)：三项真实调用链故障场景失败，两项非法身份保护通过；冷目录夹具通过后才记录此红灯。
- [修改后45项](backend.log)：`PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest backend/tests/test_watch_quote_identity.py backend/tests/test_yahoo_display_precision.py backend/tests/test_watchlist_snapshot.py backend/tests/test_quote_session_contract.py -q`。覆盖元信息未就绪、过期、报价失败，以及未知/禁用来源，报价精度、快照和交易时段回归。
- ruff、git diff --check通过。无web源码改动，使用已部署实际构建的手机UI。
- [浏览器夹具](browser-proof.json)：使用真实quote_snapshot故障返回值替换NVDA报价，隔离该行推送，验证三行身份与空价格；375/412深浅主题截图，无页面异常。写入仅夹具，无真实自选写入。
- [真实Ubuntu smoke](runtime-proof.json)：api及market-runtime中源码摘要与修复文件匹配；独立进程针对真实目录只读注入元信息失败，返回身份完整且没有伪造价格；实际页面NVDA正常。APK清单与下载摘要通过，无用户配置写入。
- 已人工查看[失败时身份保留](screenshots/failure-375-light.png)及[真实正常报价](screenshots/real-watch.png)。浏览器验证不代表Android真机验收。

## 运行环境

Ubuntu本机Docker，project `mw-managed-live-rollover-20261113`，地址 <https://192.168.7.232:18447/m/watch>。部署前磁盘41GiB、内存约4.9GiB available，仅更新api和market-runtime，web/worker/数据库不变。无需新APK。

候选api镜像经mw-docker build构建，task/project均为上述project，purpose acceptance；镜像 `sha256:92cd24d49aef909b1584cdaadb85434e297f1df6d6321ef1a80a3af9be287eae`，api与market-runtime均使用该镜像。

私有状态目录 `/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113`；启动/停止使用该目录 `start.sh`／`stop.sh`。run.json和compose.json备份后缀 `.before-watch-identity-20261114T151012Z` 保留。需要回退时恢复api镜像 `sha256:673c973a0500f4125fa9902eb22bf85b4ac436a538c6d33820604a8a424c82e8`、market-runtime镜像 `sha256:25e2db4b3ba1a60ad5547b5649395d82a53e803d619cca875bc100436a54975d`，仅本project执行 `docker compose -p mw-managed-live-rollover-20261113 -f <私有状态目录>/run.json up -d --no-build --no-deps api market-runtime`，无数据库回滚。

未操作CI、PR、commit、合并、正式tag或Unraid生产，18443未改。
