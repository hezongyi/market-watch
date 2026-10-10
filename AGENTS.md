# 部署环境约束

## 开发、验证和验收

- 只能在 **Ubuntu 本机 Docker** 部署隔离实例。
- 每项任务使用独立 worktree/branch，以及独立 Compose project、网络、volume、数据库和端口。保留其他任务的代码及实例。
- Ubuntu Docker 权限不足时，申请提权或请求用户配置本机 Docker 权限。不得将开发或验收迁移到 unraid 来绕过权限问题。
- 验收交付必须明确实际运行主机、可访问地址、启动/停止命令及验证结果；不要把 SSH 转发到远端的服务表述为 Ubuntu Docker 实例。

## unraid 生产环境

- **禁止在 unraid 创建开发、测试、验证、验收及临时调试实例。**
- unraid 只部署正式生产实例，以及正式生产发布所需的备份、回滚或切换实例。
- 正式切换完成并确认稳定后，清理该次切换留下的临时实例及不再需要的资源。
- 生产发布、切换和生产资源删除按用户明确授权执行，不从开发任务推断授权。

## 资源清理与保密

- 只按明确名称、Compose project/label 和已核实归属删除任务资源；禁止全局 prune 或影响其他任务、生产服务及数据。
- 数据迁移先验证所需备份和镜像完整，再移除来源实例。
- 登录信息、env、token、TLS 私钥、许可库和完整浏览器状态不提交仓库。

## Ubuntu Docker 构建和退役入口

- Market Watch构建使用 `mw-docker build` 或 `mw-docker compose-build`，显式提供task、project、用途；详见 `deploy/ubuntu/README.md`。禁止回退legacy builder或直接构建无归属候选镜像。
- 构建使用Ubuntu专用 `market-watch-ubuntu` BuildKit，缓存回收目标8 GiB。正式与回滚镜像用途必须明确，不参与自动删除。
- 验收结束后先查看 `mw-docker retire --task TASK --project PROJECT` 清单，再对该已结束任务执行 `--apply`；数据库必须归档且实际恢复校验。进行中任务不标记完成。
- 自动清理仅针对已完成、过期、无任何容器引用的本工具标签镜像；既有不明归属资源和其他任务不自动删除。

## 生产供源默认配置

- 用户已明确要求 Yahoo 在此后的每次生产部署保持启用。新版本使用根目录 `compose.production.yaml` 生成／核对 standalone `compose.release.yaml`，全部后端服务有效配置必须为 `ALERTS_YAHOO_ENABLED=true`；不可仅凭镜像更新或可选 overlay 宣称持久启用。
- 发布镜像引用必须固定；保留生产私有代理、数据库及其他配置。Yahoo 代理使用 `ALERTS_YAHOO_PROXY` 或既有 `ALERTS_MARKET_PROXY`。验收与开发实例仍显式决定是否启用。
- 生成部署包及切换前核对 Compose 展开配置中全部后端服务的 Yahoo 开关；部署后核对实际 Settings 和 Yahoo 读取。除非用户要求关闭，不随版本升级恢复为 false。历史 release 清单不可改写。
