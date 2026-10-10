# Yahoo 生产默认启用

用户明确要求首次生产启用后，每次生产部署、重建都保持启用。PR #33 的可选 `compose.yahoo.yaml` 不能单独保证这一点。

后续正式发布使用根目录 [compose.production.yaml](../compose.production.yaml) 作为 standalone 模板。全部 11 个后端服务明确固定 `ALERTS_YAHOO_ENABLED=true`，升级只更换发布镜像，不依赖额外 Yahoo overlay；生产私有 `.env` 中的旧 false 不会覆盖 Compose 的明确 true。Python 默认值以及开发／验收配置不变。

为发布设置 `MW_API_IMAGE`、`MW_WEB_IMAGE`、`MW_CHART_IMAGE`、`MW_BACKUP_IMAGE` 四个不可变镜像引用，保留现有生产私有代理、数据库及其他配置。生成 standalone `compose.release.yaml` 后，核对所有后端服务开关为 true，再使用既有命令启动：

```bash
./tools/docker-compose -p market-watch -f compose.release.yaml config --quiet
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build
```

私有代理必须配置 `ALERTS_YAHOO_PROXY` 或 `ALERTS_MARKET_PROXY`，凭据不提交。每次发布都核对展开配置和实际 Settings，并验证 Yahoo 搜索／解析／历史／报价；开关启用不代表上游每次请求都成功。关闭需用户明确要求后调整生产配置，保留缓存与工作区。

当前生产仍是 v1.17.0，真实检查为 `yahoo_enabled=False`；本次模板改动尚未应用生产，不改写历史发布证据。
