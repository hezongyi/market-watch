# 按资产类别与数据集配置聚合日界

用户要求：Dukascopy Python外汇、金属默认NY17；加密默认UTC；指数尚未决定。
每个数据集可明确选择NY17/UTC0覆盖默认，指数/其他类别没有隐式默认，必须选择后注册。
日界影响H4/D1及派生周月线，不改变来源M1，不要求供应商原生高周期一致。
NY17使用America/New_York当地17:00并随DST转换，UTC0固定UTC00:00。

行情数据页增加“添加历史品种”、资产类别/价格精度/准确来源代码、聚合日界选择，
已有历史可保存新日界并选已发布版本复用原M1。来源代码/精度由用户明确配置，
注册成功不证明供应商品种可用或历史没有缺口，下载时仍执行来源/精度校验。

API：GET /api/market-data/aggregation-options；POST /api/market-data/datasets；
POST /api/market-data/datasets/{id}/aggregation。新建注册可省略聚合日界以采用已定义的类别默认；
指数省略会返回422。修改日界返回新数据集和可选派生版本，原身份、版本、固定回放不变。
派生复用原不可变M1 chunks，history worker按分块推进，无需重新下载。
重复提交同一个原版本/目标日界复用同一派生任务，目标已有其他历史时拒绝覆盖。

迁移x25_dataset_asset_class添加类别字段。既有数据集标为unspecified，不猜测类别、不重切既有日界。
旧数据集仍显示已保存日界。命令行创建支持--asset-class、--aggregation-calendar、
--provider-symbol；所有品种都要求准确来源代码和精度，指数必须明确日界。

验证：

- [86项定向回归](configurable-aggregation-final-tests.txt)：默认/覆盖、指数待定、实际API、
  新身份、分块派生、固定回放不变、迁移升级及NY17/DST/周月边界通过。
- [Ubuntu PostgreSQL两项](configurable-aggregation-postgres.txt)：本项目独立临时schema，
  实际新日界派生和旧表迁移保留日界通过，测试完成删除临时schema。
- [前端构建](configurable-aggregation-web-build.txt)通过。
- [Ubuntu Chromium交互](configurable-aggregation-browser.json)通过类别默认、指数无默认、注册、
  切日界/选择原M1版本、移动端无溢出。该浏览器使用fixture API；实际后端API/PG另有上述验证。

这些修改保存在本地，未推送/创建PR，未重新部署正在长期观察的实例。
浏览器临时构建预览在验证后停止；后台原质量观察继续，不能把旧版本观察当成新功能长期验证。
组合行情源尚未实现，用户当前要求先分析其合理性/必要性，不因此扩展为开发授权。
