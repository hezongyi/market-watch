# v1.21.2 正式生产证据

实际应用运行在 unraid `192.168.7.33`，project `market-watch`；浏览器、发布构建和隔离 PG14 备份恢复均运行在 Ubuntu。版本、操作方式、验证边界与回滚入口见 [生产交付](../../pro-charts-v1.21.2-production-delivery.md)。

本目录保留实际部署检查的 JSON 摘要。`index.json` 列出内容 SHA256 和隐私裁剪：移除工作区 ID／revision、原始账号及业务指纹、完整表计数、组合身份及其他任务容器 ID；实际原始比对仍在私有发布记录中保留。没有提交 env、凭据、dump、许可库、截图或完整浏览器状态。

`database-restore.json` 是最终备份由正式 v1.21.2 镜像进行的 Ubuntu PG14 实际恢复验证。`runtime.json` 和 `alert-config-preservation.json` 区分已保存告警定义与 worker 可变运行字段。`worker-stability.json` 明确短期观察窗口；`production-browser.json` 记录只读 UI／行情订阅范围。`resource-final-check.json` 只把本轮已退役项目的明确清理结果记为通过，不推断其他任务容器的身份变化原因。
