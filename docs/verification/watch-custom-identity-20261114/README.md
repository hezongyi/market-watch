# 自选自建品种三行身份

P0：手机自选的名称/供应商展示与局部样式。实现提交 9f81074b、0f2bc58b；无后端、行情订阅或数据库变更。

自建行显示代码、简短说明、淡蓝色自建标记＋供应商简称。实时接续取描述中的历史来源，避免把“实时接续”或实时供应商当作历史来源；完整来源保留在 title/原详情中。Dukascopy 简写 Dukas，原生行保留灰色供应商。

真实 EURUSD 固定历史仅返回代码，无中文说明，因此补充常见货币对的中文简称。确实没有中文名的其他品种沿用可用名称，缺失时显示名称待确认，不编造翻译。

## 验证

- npm run build、git diff --check 通过。
- 现有 A07 浏览器脚本增加身份范围入口，执行如下命令：

```sh
cd web
MOBILE_VISUAL_SCOPE=identity MOBILE_VISUAL_OUTPUT=/tmp/mw-watch-custom-identity-verified-20261114 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
node tests/mobile-watch-a07.browser.cjs
```

8组布局全部通过，覆盖375/412px、横屏、深浅主题、150%字号；验证自建与原生混排、接续的历史供应商、缺中文名、默认72px行高、71.4px左列、67.2px右列与sparkline空间。此次仅运行身份/几何范围，不声明后半段控件流程通过。

第一轮截图发现150%字号时原有shadcn固定高度导致三行与下一行重叠；改为height:auto后第二轮截图确认修复，默认字号仍为72px。

- Ubuntu真实服务只读浏览器检查6组：375/412px、深浅主题、150%字号；用更多中的主题按钮实际切换，未改用户自选数据。
- 真实固定历史EURUSD显示“欧元美元 / 自建 Dukas”，内容不越出行，默认列宽和行高未变化，零页面异常。真实接续品种来源使用API格式夹具验证；未为本次UI检查新建或切换真实行情。
- 对比：[之前](before.png)、[真实深色](real-dark.png)、[真实浅色](real-light.png)；[混排浅色](mixed-light.png)、[混排深色](mixed-dark.png)、[大字号修复后](large-text.png)。真实运行尺寸见real-proof.json。
- 浏览器验收，不代表Android真机验收。原有“暂无日内数据”不属于本次身份展示修改。

## 部署

Ubuntu quant-server 本机Docker，project mw-managed-live-rollover-20261113，地址 https://192.168.7.232:18447/m/ 。仅替换web，保留原后台、数据库及自动轮换实现；未操作Unraid。

镜像 market-watch-web:managed-watch-identity-20261114，实际ID sha256:f6c98bc33dffe1a751a0965051d4db6946a59c986a5374b291d9ef91f9dfd6dc，源码0f2bc58b，shell fcfdc484373f53d7。API/PG健康，web运行正常；APK无需重装。

```sh
~/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
~/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```
