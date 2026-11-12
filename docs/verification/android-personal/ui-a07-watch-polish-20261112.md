# 自选页面截图驱动优化

用户授权自行优化自选页，要求实际截图确认后交付。P0 样式调整，沿用已确认的代码 / 行情种类与供应商两行结构。使用既有 ui-ux-pro-max 的可读性、触摸与响应式原则；不新增设计系统或 UI 库。

## 视觉决策

第一轮在实际验收页面注入候选 CSS，检查 375/412 深浅截图，发现把左列从约 86px 扩到 120.4px 后，Binance / Dukascopy 可完整显示；右列仍为 84px（窄屏 81.2px），小图获得剩余空间。采用该布局。

- 常规行高 94 → 84px，上下 padding 14 → 12px；7 行共减少 70px 空白，保留充足点击区域。
- 左侧保持代码 15px / 650、来源 12px 的首尾两行样式，统一 8.6rem 列宽。更长的未知来源仍使用省略，大字号继续将小图移至下一行。
- 空图提示用更高特异性的选择器固定为 muted 灰色，避免继承品种红绿涨跌色，字号 11px。
- 通信时间从 12px 到 11px、间距 5px 到 3px；延迟说明从 11px 到 10px、距行底 5px，减少对报价的干扰。
- 没有改动价格精度、行情读取、曲线数据、昨收线、颜色或纵向缩放算法。

第二轮检查构建产物的 8 组布局截图，以及 150% 字号、空图、离线与弹层。最后部署后检查实际行情四组截图；当前 7 行的 Binance / Yahoo / Dukascopy 来源全部无截断，三列中心对齐，无价格与小图碰撞、横向溢出或 pageerror。浅色 375 和深色 412 已人工查看并确认。仅网页截图，真机效果待用户复核。

证据：[前后对照](a07-feedback/watch-polish/before-after.png)、[实际行情检查](a07-feedback/watch-polish/proof.json)、[布局检查](a07-feedback/watch-polish/layout-proof.json) 和同目录截图。前后截图采样时间不同，行情数值和曲线变化不是视觉修改。构建、A07 布局及 A06 长代码/大字号脚本均通过；未跑 CI / 更新 PR。

## 运行

Ubuntu quant-server / 192.168.7.232，本机 Docker project `mw-android-personal-v205`，地址 <https://192.168.7.232:18445/m/>。部署前磁盘可用 29GiB、内存约 9GiB，复用五服务，仅更新 web。

- 网页 build `a96ba59082efe541`，CA 校验 HTTPS readyz / manifest 200。
- web `sha256:e579f6635e30203257d5aef4479aee420ac423527dd35c7fe6ef66f0edefc6ed`，通过 mw-docker 明确标记 task / project / acceptance。
- 旧 web `sha256:9a1afa76c1aa95659ac5a948a282844c780023e42d601170e5f0c72efea64760`；私有配置备份 `before-watch-polish-run.json`。
- APK 仍为 0.1.3，通过更多 → 检查更新刷新网页。

启动：

```bash
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --wait
```

停止使用相同前缀与配置，将末行改为 `stop`。本次仅执行 `up -d --no-build --pull never --no-deps --wait web`；无数据库重置或 Unraid 修改。
