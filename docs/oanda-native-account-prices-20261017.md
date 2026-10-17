# OANDA 平台历史和最新蜡烛统一账户口径

2026-10-17。Issue #74 后续补丁，F1：改变平台缓存内容版本及后台消费边界，无 schema 迁移。

GBPJPY M5 首次加载后约两秒出现第二次整图闪空。真实对照发现，平台历史此前使用
`/v3/instruments/{instrument}/candles`，实时使用
`/v3/accounts/{accountID}/candles/latest`。同一已完成柱在两类接口间存在价格差异，
写入共享缓存后被正确识别为历史更正，触发 `history_changed → reloadHistory → resetData`。
此差异并非指标预热；不能将观察到的差价推广为固定加点规则。

平台历史改为 `/v3/accounts/{accountID}/instruments/{instrument}/candles`，与最新蜡烛
使用同一个配置账户、`units=1`、价格侧、平滑与日历参数。原有供应商时钟、排他分页边界和
明确 future-to 拒绝后的有界回退保持有效。真正的历史修订仍触发更正机制。

## 配置维护

服务端私有配置同时维护 `ALERTS_OANDA_TOKEN` 和 `ALERTS_OANDA_ACCOUNT_ID`。
账户 ID 必须明确指定；一个 token 可授权多个账户，系统不会默认取第一个账户。
启动目录读取及低频认证探测先调用 `GET /v3/accounts`，确认配置账户在授权列表中，
再查询其 instruments。账户不在列表中进入 unauthorized 处理；401/403、网络失败及坏结构
继续保留各自错误，不能返回空目录冒充成功。普通历史请求和每两秒 latest 不重复查询账户列表。

更换 token、仍使用相同账户时，保留账户 ID；token 不进入数据身份。更换账户时同时更新
所有后端服务的私有配置并重启，账户哈希使新旧平台缓存分开。不要把 token 或账户原文放入
仓库、浏览器或验收材料；不要自动改写固定组合历史。

## 缓存兼容与回退

OANDA 平台缓存采用 `oanda-account-candles-units1-v2:<参数哈希>` 内容版本，默认和自定义
价格侧/日历参数均隔离。新版本首次读取需重新获取数据，不复用旧接口价格。
旧 ProviderDataset、bars、固定指标结果及已发布组合历史保留，不做原地迁移或删除。
旧版本实时与历史预热 interests 不再消费；已有流任务通过既有 dataset identity fence 要求重载。
Dukascopy、Binance、Yahoo 的版本不变。

Ubuntu 验收复用 `mw-issue74-20261017`，不新建数据库服务。回退使用保留的旧 API 镜像和
私有 Compose 配置，再重启同项目后端服务；旧缓存仍存在。旧版本本身仍有此次接口差异，
回退不等于解决闪空。生产部署、删除旧缓存均不在本次授权范围内。

## 验证范围

回归覆盖真实调用链 `native_page → provider cache → account latest → native publisher →
market_stream.delivery`：相同账户价格应交付 bars，随后真正更正已完成旧柱仍返回
`reset/history_changed`。另覆盖账户缺失、多账户明确选择、错误分类、旧缓存保留与隔离、
token 轮换、账户切换、旧 interests 退出及现有分页/高周期行为。

定向单测、PostgreSQL 检查和浏览器实测结果单独记录；此补丁通过不代表 Issue #74 全部验收通过。
窗口取 bar 速度、真实更正时主图恢复方式、EMA500 固定计算起点问题不在本次改动内。
