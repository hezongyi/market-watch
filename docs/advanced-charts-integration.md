# 独立图表接入：开发验证版

2026-09-29，分支 `feature/advanced-charts`。主分支 v1.1.0 及生产未切换。

## 入口与启动

开发入口：http://192.168.7.232:5188/advanced-charts ，沿用开发账户密码。
旧入口：http://192.168.7.232:5188/chart-workspaces 。

在当前工作树下运行（`.env` 必须指向 `trading_alerts_dev` 且关闭通知发送）：

```sh
python scripts/install-advanced-library.py /path/to/TV_v31.1.0_0430.zip
PYTHONPATH=backend .venv/bin/alembic upgrade head
PYTHONPATH=backend .venv/bin/python -m uvicorn alerts.api:app --host 127.0.0.1 --port 8001 --no-access-log
python advanced-host/serve.py
cd web
MARKET_WATCH_API_URL=http://127.0.0.1:8001 npm run dev -- --host 0.0.0.0 --port 5188 --strictPort
```

以上是三个独立进程。前端构建配置 `VITE_ADVANCED_CHART_ORIGIN` 指向专用静态图表来源；生产必须配置独立 HTTPS 主机名（不能只改变端口，Cookie 不以端口隔离）。Python 静态服务器仅用于开发。

## 边界与存储

- 原策略、行情采集、修复、日历、通知代码不修改。
- 图表库及自编 datafeed 放于专用来源，父页面通过 source + origin 校验消息。
- iframe 只允许 scripts/same-origin，不允许弹窗、表单、顶层导航；图表来源 CSP 禁止 connect-src、外部脚本/图像/字体。
- 同源内部 iframe 是库的正常运行需求。不同来源隔离保护父页面 DOM/localStorage，父页面不发送 Cookie、密码、CSRF 或行情 API Token。
- 父页面仅代理三种品种、九种周期、限量查询和单指标参数；并发受限。这里只开放行情与当前图表文档，不开放预警、账户和通知 API。
- 新表 `advanced_chart_workspaces`，engine=tv31/schemaVersion=1，独立 CRUD、revision 乐观锁、冲突暂停和本地草稿恢复副本。
- 库的布局/画线数据为黑盒保存，旧 Lightweight Charts 文档不转换、不覆盖。
- 复制含布局、指标、画线、模板；手机入口禁止持久化修改，隐藏主要编辑入口，不视为完整触屏编辑产品。
- 核心库为本地安装的授权资产，不提交 Git；仅提交安装器及 SHA256 清单。用户已确认个人私有使用授权。

## 行情与指标

- 前端不重新聚合 OHLC，启用 disable_resolution_rebuild；M30/W1/MN 使用原后台。
- 分钟/H4 使用实际开盘 UTC 毫秒；D/W/M 按库约定转换为 UTC 零点交易日期标签。
- NY17 日线用纽约收盘日期，周线用周一日期，月线用所属月份首日；BTC 使用 UTC0。
- 最新数据每15秒读取（源仍为 M1），同参数查询短时合并、队列并发最多4；历史请求分页。
- `守望 Python ...` 八类指标来自原 Python calculate，不在 JS 重写算法。通过隐藏辅助 symbol + custom study 将后端计算值映射到图表，缺失/预热值不画成零。
- 新 Python 插件注册 metadata/calculator 后，catalog 自动生成网页参数、线条和副图。当前通用绘制支持 line/histogram；复杂新图形需扩展适配。
- 库自带指标仍可选，但不承诺其计算口径与 Python 预警一致。需要一致时选择“守望 Python”。

## 已验证

- TypeScript/Vite 生产构建通过。
- 后台全套：122 passed / 5 skipped（可选 PostgreSQL、备份恢复依赖条件未开启），并未发送真实通知。
- 新旧工作区隔离、拒绝跨表 ID、版本冲突、认证、格式校验测试通过。
- 9项日历标签测试：NY 夏令时、周/月边界、UTC0、H4不变。
- 开发 PostgreSQL 应用独立迁移，浏览器完成保存与恢复。
- 六种布局1/2h/2v/2-1/1-2/4均返回预期图表数量；手机新建禁用，所测菜单没有新增404。
- 单图与四图运行；9种绘图对象（多/空分开）创建成功，同品种四图均有9个对象，刷新仍保留。
- 八类 Python 指标均创建成功，SMA实际曲线可见；参数通过现有后端校验。
- M1/M5/M15/M30/H1/H4/D1/W1/MN均能切换并保留画线；开发月线只有一根且不完整，不代表充分历史验收。
- 深浅色切换；主流程没有浏览器 pageerror；复测出现 Google Analytics 脚本加载尝试，被 CSP 明确阻断。

## 尚未达到生产切换条件

1. 包完整性问题：exportData 请求 `bundles/export-data.bb1bdc415916b47fed24.js` 返回404，原ZIP也缺失。不能用其他hash文件冒充。已请求同版本完整包/清单。未提供数据导出入口。
2. 需要对图表内实际数据逐根导出对照；目前导出API被缺失文件阻断。已测试适配时间转换，但不把它等同于实际渲染完整对照。
3. 不同周期十字线/范围同步、长历史/未来锚点、工作区切换和模板复杂交互仍需完整验收。同步API可用不代表所有边界已确认。
4. 生产需静态图表独立HTTPS域名、部署配置、CSP复核及应用备份/回退演练；本轮没有部署到unraid。
5. 内置额外工具不属于承诺范围。旧画线迁移、完整手机编辑、图上预警、自动交易不在本次接入范围。

## 安全审查结论

并非“证明无恶意代码”。静态字符串扫描见 advanced-static-scan.json；发现的广告域名样本是 CSP 错误过滤代码，new Function 样本是 webpack globalThis fallback，不能把字符串命中直接判为恶意。没有官方原包作逐文件比较，真实性仍未核实。

仅安装 charting_library，排除第三方 AkShare/CryptoCompare/broker示例、示例密钥和外部保存服务。先前模拟页面曾观察统计脚本请求；本接入复测仍发现 Google Analytics 脚本加载尝试，浏览器报告 CSP 阻断；不可把尝试请求记录误写为已成功访问外网。静态审查和有限行为测试不能覆盖所有潜在执行路径。
