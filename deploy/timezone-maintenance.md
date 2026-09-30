# 时区规则维护

## 来源与职责

后台 `backend/alerts/domain.py` 使用 Python 标准库 `zoneinfo.ZoneInfo("America/New_York")`，读取 IANA 时区数据库。应用只规定纽约当地17:00的交易日边界，不自行维护每年夏冬令时切换日期。UTC0品种不受纽约切换影响。

2026-09-30本机验收API容器实际使用 `/usr/share/zoneinfo/tzdata.zi`，版本2026b。此记录不是生产容器版本证明。Python镜像基于Debian bookworm；系统时区数据随基础镜像提供。宿主机更新不会更新已运行容器中的文件。

浏览器显示使用浏览器Intl时区数据，原生库另有其显示规则；浏览器和供应库更新应同时验证标签。行情聚合仍以后端为准。交易日历的假期、维护窗口与IANA夏令时规则是不同来源，更新tzdata不会自动更新OANDA假日安排。

## 更新流程

1. 定期检查IANA tzdb发布以及Debian基础镜像的tzdata更新；在美国时间政策变更或项目依赖升级时检查。正常年度切换不需要改代码。
2. 在开发机拉取更新的基础镜像并重建候选API/worker镜像，记录镜像ID及容器内实际tzdata版本。仅重建使用缓存的旧基础镜像，不能保证获取新版数据。
3. 运行domain、calendar_profile、oanda_schedule后端测试，以及web/tests/advanced-time.cjs和advanced-daily-labels.browser.cjs；核对春秋切换、NY17锚点、日线日期及OHLC。
4. 若新规则影响已有历史分桶，先在开发库比较受影响日期；按范围演练重新聚合和策略结果对照，不直接重写生产历史。保存回退镜像与数据库备份。
5. 按项目发布流程更新API和worker。更新后重新启动进程，使zoneinfo缓存与新数据一致；记录实际版本和回归结果。

没有配置自动升级生产容器的任务。可由维护Agent定期检查并提出升级，但规则来源始终为IANA及发行版，不让Agent生成替代日期表。
