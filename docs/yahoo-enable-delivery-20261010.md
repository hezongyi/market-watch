# Yahoo 显式启用交付

本 session 曾要求启用 Yahoo。功能代码已合入 main，但 2026-10-10 的生产读取确认 `yahoo_enabled=False`，AAPL 目录为空；不能称启用完成。

本 PR 增加 [compose.yahoo.yaml](../compose.yahoo.yaml)，对当前正式 Compose 的全部后端服务显式启用 Yahoo，使 API、目录刷新、历史和报价 worker 使用一致配置。它是选择性 overlay；Python 默认开关仍由部署选择。私有 `.env` 必须配置 `ALERTS_YAHOO_PROXY` 或已有 `ALERTS_MARKET_PROXY`；不在 Git 保存代理地址／凭据。代理缺失继续返回原有 configuration 错误。

当前正式部署的配置预览方式（尚未执行生产变更）：

```bash
./tools/docker-compose -p market-watch -f compose.release.yaml -f compose.yahoo.yaml config --quiet
```

正式应用需将 overlay 随部署包放入生产根目录，先备份配置，再以相同组合执行 `up -d --no-build`。后续启停和重建均使用两个 `-f`，否则会恢复原 `.env` 的关闭值。通过 API 搜索 AAPL、真实解析／历史／报价与实际代理读取验收后，才能记录启用完成。不开新采集 worker、不迁移 schema、不改变历史业务。

关闭时回到原 Compose 和私有 env 的原值并重建相关服务；保留 Yahoo 缓存与工作区。此 PR 仅交付可审查的配置，不变更 unraid，不声明真实 Yahoo 上游验证通过。
