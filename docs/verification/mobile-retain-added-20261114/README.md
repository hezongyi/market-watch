# 添加自选：本次保留勾选条目，下次排除

2026-11-14，用户确认添加成功后本次搜索保留条目并显示勾，下一次打开搜索才排除。F0：兼容增加两处读取API的可选 `retain_watch`，无schema/持久格式变更。沿用手机UI skill和现有shadcn按钮，不改搜索布局、行情主体或实时生命周期。

## 行为与实现

- 自选搜索添加成功不再立即remove/requery。原生/自建条目保留原位，右侧加号改勾且禁用，保存失败/冲突不标成功，原提交防重与冲突保护保留。详情内加入与行内加入共享同一路径。
- 当前抽屉在内存保存本次加入身份，换词、返回详情、后续分页仍保留。目录读取将这些身份从已关注排除集暂时扣除，保持分页前资格集合稳定，避免新增后offset前移导致漏项；后台继续按真实身份归一处理原生别名、自建版本/接续身份，写入防重不受该只读参数影响。未使用参数时原接口行为不变。
- 关闭抽屉后本次保留集释放；重新打开按所有分组已关注身份排除。前端也过滤旧缓存中已关注而非本次加入的行，避免缓存重新带回可添加项。添加自建目录与数据详情加入逻辑不变。

## 验证

- [构建](build.log)、ruff、`git diff --check`通过。[后端15项](backend.log)：`PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest backend/tests/test_mobile_symbol_search.py backend/tests/test_directory_compatibility.py -q`，覆盖保留参数分页前生效、原生和自建默认排除不变、API兼容与写时防重。
- [共享搜索浏览器](search.log)：`MOBILE_SEARCH_OUTPUT=/tmp/mw-retain-added-search-20261114 node tests/mobile-symbol-search.browser.cjs`，原生/自建成功均保留、勾/禁用、行位置差小于1px、无添加后重搜；两目录翻到底82个身份且无跳项，下一次打开排除，当前组添加正确，失败重试、查询取消和375/412px深浅主题/150%字号通过。真实写入仅HTTP夹具。
- [详情与数据浏览器](data.log)：`MOBILE_DATA_OUTPUT=/tmp/mw-retain-added-data-20261114 node tests/mobile-data.browser.cjs`，详情加入、冲突、读取失败、离线及MWC/MWH选择回归通过。
- [Ubuntu真实运行](runtime-proof.json)：六个后端文件与web资源摘要匹配当前构建；只读验证寒武纪默认已关注排除3条，传入当前保留身份4条，再次不传参数仍3条；自建默认4个，保留已有关注身份6个。浏览器无异常/用户配置写入。APK更新清单及0.1.3包摘要通过，无需新APK。
- 已人工查看[成功勾选夹具截图](screenshots/added-native-managed.png)。实机动作仍需用户复核，浏览器验证不称为Android真机完成。

## 环境与回退

实际主机 Ubuntu quant-server 本机Docker；project `mw-managed-live-rollover-20261113`；地址 <https://192.168.7.232:18447/m/watch>。部署前磁盘41GiB、内存4.6GiB available，仅替换api/web，worker/数据库不变。两个镜像均使用task/project归属明确的 `mw-docker build`，purpose acceptance：

- api `sha256:673c973a0500f4125fa9902eb22bf85b4ac436a538c6d33820604a8a424c82e8`。
- web `sha256:4a4f69806e0b273e58f3f90d0c44b8031a7dd0acfcf672ca8817c47c6f53e28a`；shell `f23872eb477f808b`。

私有状态目录 `/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113`，启动/停止为该目录 `start.sh` / `stop.sh`。`run.json` / `compose.json` 的 `*.before-retain-added-20261114T145915Z` 备份保留；downloads只读挂载保留。回退时恢复api旧镜像 `sha256:ef51751b121e3ca22699aec250953c8070ce0873c328c9379d43f27c1058b529`、web旧镜像 `sha256:e1bde0af88ba9f5cf45ad3cca0d7afbd520ddf64f85b1e859551675b55118717`，仅本project执行 `docker compose -p mw-managed-live-rollover-20261113 -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json up -d --no-build --no-deps api web`；无数据库回滚。

未执行远端CI、PR/commit/合并、正式tag或Unraid生产操作，18443未改。
