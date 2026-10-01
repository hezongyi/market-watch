# Advanced Charts 原生历史接口独立验证

日期：2026-10-01。结论：验证工作已完成本轮对照；所提接入机制**未通过完整可行性门槛**，不能进入产品集成并宣称问题解决。

## 隔离与复现

新增 `web/tests/fixtures/native-history.html` 和 `web/tests/advanced-native-history-contract.browser.cjs`。
验证页由 Playwright 对本机静态源的一个测试 URL 返回，不部署、不改变原生 bundle；无应用 bridge、无登录、无工作区保存、无后台 API、无数据库和 OANDA。实际 UI 操作由 Playwright 完成；产品实现没有读取原生 DOM 或私有模型。

- Chromium，1440×900，固定时间 2026-09-29 UTC。
- 合成 UTC 24×7 日线，确定性 OHLC；依次开放 0/20/80/400/600 根；M5 使用独立预备数据。
- 原生库与本机候选使用相同文件，使用可用的中文语言包。
- charting_library.js SHA256：`2b49390b118321b574f11119d3d9b9e1b8dad7af22aa8d674425ad75f0c7ab41`
- library.e2f8b3a016c9e1a0b7a5.js SHA256：`114428b8dde6eb137fd7ef3bc20ef35882189186c4bd092bb743b64d11682be1`

从 `web/` 运行：

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu \
node tests/advanced-native-history-contract.browser.cjs
```

依赖已运行的 Ubuntu 静态 chart-origin `http://127.0.0.1:15187`。测试预期保留失败断言；退出1表示完整需求尚不成立，不是测试安装失败。可设置 `NATIVE_VISIBLE_RESET=1`、`NATIVE_MODE=nextTime` 或 `NATIVE_MODE=error` 进行单变量对照。

## 最终基线结果

原始事件：[boundary.json](verification/native-history/boundary.json)。共10项，7项通过、3项失败；无页面脚本错误、无请求失败。图片 `/tmp/mw-native-partial-80.png` 已人工视查，80根实际绘制；不是仅统计 feed 回调数量。

| 验证 | 结果 | 具体证据 |
|---|---|---|
| 初始空数据结束本次加载 | 通过，但有接口差异 | onDataLoaded触发，dataReady仍false，visibleBars=null |
| 0→20根显示 | 通过 | resetCache + resetData + onDataLoaded + 两帧等待 |
| 20→80根，保持最新端柱宽/偏移 | 通过 | spacing=6、rightOffset=10均保持；可见数据向左增长 |
| setVisibleRange跳到本地边界之前 | 失败 | 目标from=1781136000/to=1782864000；被截为1783728000/1783814400，无getBars或携带目标的interval事件 |
| 原生Alt+G日期按钮跳到2026-06-01 | 失败 | 真正填写并提交原生日期对话框；无getBars，仅loaded事件，仍停在已加载边界 |
| 真实鼠标向右拖动越过历史边界 | 失败 | 多个range事件，但from始终被夹在1783728000，无历史请求 |
| D1不足时切M5 | 通过 | 最终基线约25ms，dataReady=true；仅合成内存数据，不能外推真实网络性能 |
| 回D1补到400根 | 通过 | 有效可见数据增加，柱宽和最新端偏移保持 |
| 正向对照：400根中跳到原生尚未读取的更早范围 | 通过 | getBars发起请求176根，范围精确到目标，证明请求监测有效 |
| 历史视区下400→600根 | 通过 | from/to完全一致，spacing一致；不等于刷新时同时操作的竞争验证 |

注意：原生周期切换本身不保证柱宽继承；早期基线日期跳转导致柱宽变大后，切M5继承了改变后的柱宽。需要外层明确管理用户柱宽偏好。

## 对照实验

### 1. request_only_visible_range_on_reset

[visible-reset.json](verification/native-history/visible-reset.json)：开启后，同样三项越界交互失败。它控制重置的请求范围，不能自动把暂时无数据变成可继续浏览的历史边界。

### 2. 非空短页noData=false，空页nextTime

[nexttime.json](verification/native-history/nexttime.json)：空页提示当前可用最早时间（该包运行逻辑按秒使用）；80根阶段出现50次连续空页请求，库随后自行结束历史。最终仍不能向前翻图。`nextTime`不是“后台准备中”的状态字段，此实验不能作为接入方案。

### 3. 非空短页noData=false，空页错误回调

[error.json](verification/native-history/error.json)：20→80根刷新超时，随后setVisibleRange出现Value is null。错误回调不能用作正常的后台等待状态。

### 4. 早期英语验证页

最初用了包中不完整的英语语言资源，UI未完整加载；这些结果不计作原生UI验证。已切为中文并重跑全部基线，最终无资源失败。

## 对方案的影响

证据支持：公开接口可分批显示历史、恢复已知视区、快速切换到内存数据。
证据不支持：将每个本地快照的缺口映射成noData，再仅凭公开range/interval事件可靠恢复所有原生越界交互。尤其原生日期按钮的目标未被所测事件暴露，协调器无法凭空恢复该目标。

因此暂停此方案的产品改造。保留后台工作和现有原生UI，不把测试改成忽略失败，不改bundle，不以隐藏日期按钮或截获私有DOM实现绕过。

## 下一步建议与门槛

1. 先验证能否通过公开时间范围/首次请求参数，使冷启动的原生请求量匹配当前已有完整K线，而不提前声明永久历史结束。保持用户柱宽是硬要求，不能通过自动放大少量K线伪造“满屏”。这一条尚未实测，不作可行承诺。
2. 若仍不成立，评估明确的“加载中请求”生命周期：短等待、按图表取消、与其他图表独立，并测量部分首屏是否显示以及旧请求是否阻碍周期切换。不能把原先无限循环等待原样搬回去。
3. 若公开接口下仍无法同时满足全部要求，再向用户提出明确取舍，或利用库供应方支持确认接口。不能擅自降低渐进显示/原生UI/历史跳转要求，也不能声称更换库已获授权。

本报告完成的是接口能力验证；冷启动导航产品功能仍未完成。整体实施目标保持未完成。

## 第二轮：公开timeframe接口验证

用户同意后新增 `web/tests/advanced-native-timeframe.browser.cjs`，继续使用同一独立fixture。
从已有20根完整D1开始，默认柱间距6px，目标timeframe取现有数据内最近10天；M5→D1切换路径在onIntervalChanged事件的timeframe未定义时填写正式支持的time-range对象。分别开启/关闭 `determine_first_data_request_size_using_visible_range`（当前产品使用此开关）。

复现命令与上方相同，仅将脚本替换为 `tests/advanced-native-timeframe.browser.cjs`。输出 `/tmp/mw-native-timeframe.json`，固定存档 [timeframe.json](verification/native-history/timeframe.json)。六个全新浏览器页面顺序运行，无应用API、无持久化、无资源/脚本错误。测试退出1，因为没有候选满足全部条件。

| 组合 | 首次D1请求countBack | 初始柱间距px | 综合结果 |
|---|---:|---:|---|
| 无timeframe | 301 | 6 | 请求超出现有20根 |
| 初始化timeframe | 302 | 102.3 | 请求超出且自动放大 |
| onIntervalChanged调整timeframe | 301 | 102.3 | 事件修改生效于视区，但没有减少首次请求 |
| 仅按可见范围计算首请求 | 173 | 6 | 请求仍超出现有20根 |
| 初始化timeframe＋按可见范围计算 | 11 | 102.3 | 首次请求可满足，但柱宽不保留 |
| 事件timeframe＋按可见范围计算 | 173 | 97.8 | 请求超出且自动放大 |

最有希望的第五组：首次请求11根、返回11根、noData=false。随后通过公开timeScale接口恢复6px和rightOffset=10，立刻触发countBack=154的后续请求；剩余本地历史仅9根，返回短页后仍进入结束状态，真实鼠标向前拖动不再发起请求。这是有意义的正向对照：初始化timeframe确实可以减小首请求，问题是无法同时维持用户柱宽和少量历史下的开放分页。

每组均检查初始部分数据可见、首次请求不超过20根、原6px柱宽、恢复柱宽后未宣告结束、真实鼠标继续分页、无运行错误。六组均未同时通过。onIntervalChanged事件及其修改后的timeframe记录在JSON中，不是因事件未绑定而失败。

结论：本轮两条公开接口路径未能满足既定组合要求。不能将“指定更小timeframe”作为已经验证可行的产品修复，也不能把自动放大少量K线当成满屏体验。不再沿这个方向追加局部产品补丁。

后续选择仍需验证：缺口请求保持可取消的等待状态而不误报永久结束，是否允许已到达的部分数据显示、原生UI交互是否仍可用，以及其他周期请求是否独立。它不是本轮已验证方案，也不能重新引入原先无限等待的调用链。
