# A 股 sparkline 昨收参考线修复

2026-11-14。F0：兼容的手机 sparkline 后端逻辑修复，无 schema、持久格式、采集身份或图表页策略变更。

## 原因与修复

A 股日内曲线有数据，但参考价为 null。原逻辑只接受结束于全天窗口边界的完成柱；真实 A 股收盘分钟结束于上海 15:00，原生日线以 UTC 日期标签存储、结束于上海 15:10 确认边界，因此已有昨收被排除。

按明确的 AKShare 沪深北身份判定收盘证据：接受前一实际日期 15:00 的完成分钟柱或 15:10 确认的完成 D1。价格只从同一来源、复权和缓存身份读取。显示周五曲线时参考周四收盘；不用周五收盘或开盘替代。缺少完整收盘分钟时，显式 prepare 使用同身份 D1 补取展示日之前三条；batch 保持只读，无外部请求。自建读取路径也传递其基础身份。缺少可靠证据仍不伪造参考价。

保留交易横轴、M5显示采样、折线与面积色、纵轴和手机布局；其他市场保持原判定。

## 验证

- 修复前新增真实 provider→batch 测试：两项均因 previous_close_price 为 null 失败；原验收实例的 HTTP 检查同样失败。
- [后端结果](backend.log)：`PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest backend/tests/test_sparkline_a_shares.py backend/tests/test_sparklines.py backend/tests/test_sparkline_sessions.py backend/tests/test_sparkline_rollover.py backend/tests/test_sparkline_backfill.py -q`，75 passed。新增新浪/腾讯、当前日/周末、日线确认、未完成/非收盘分钟排除、复权隔离及 D1 补取截止日期检查。
- ruff、git diff --check 通过。
- [Ubuntu真实响应与浏览器证据](runtime-proof.json)：寒武纪 688256 展示 2026-11-13 的240点，昨收973.00，时间为2026-11-12上海15:00；与同身份原生D1收盘973.00相同。页面实际出现一条昨收SVG参考线，title为展示日与973；API源码摘要匹配。无页面异常、无自选配置写入。
- 375/412px、深浅主题、150%字号八组截图无横向溢出，已人工查看[普通浅色](screenshots/watch-412-light-14.png)与[大字深色](screenshots/watch-375-dark-21.png)。APK下载和更新包摘要保持有效。浏览器验证不替代Android真机复核。

## Ubuntu验收实例

主机：Ubuntu本机Docker；project `mw-managed-live-rollover-20261113`；地址 <https://192.168.7.232:18447/m/watch>。部署前磁盘41GiB可用、内存约4.8GiB available；仅重建api，其他服务与下载挂载保留。无需新APK。

API通过mw-docker build构建，task/project均为本任务，purpose acceptance；镜像 `sha256:1f40d2a2341316837dae255f10e5a0dba58010c39a62c169bd45e85f70cf7094`。web仍为 `sha256:fcc379e1ea0b59221679fd1e7db2a4b9c26f80a6bf5a2ea323e172ba601dc9a1`，shell `c3b5bb975dbf9299`。

启动/停止：私有状态目录 `/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113` 下 `start.sh` / `stop.sh`。run.json与compose.json备份后缀 `.before-ashare-reference-20261114T164734Z`。配置回退只恢复本project的api镜像 `sha256:e84772545ca5b36647f3edf6195136c34a5ea787616bc883890fd69415fe13b5`，再执行 `docker compose -p mw-managed-live-rollover-20261113 -f <私有状态目录>/run.json up -d --no-build --no-deps api`；无数据库回滚需求。

未操作CI、PR、commit、合并、正式tag、Unraid或18443。
