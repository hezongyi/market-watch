# 隔离图表静态来源部署准备

本机已完成原Dockerfile构建、隔离容器及HTTPS联调；尚未生产部署。当前复现步骤见[本机容器验收](local-container-acceptance.md)。

## 构建

先按现有许可安装脚本将供应商包安装到advanced-host/charting_library，再执行：

```sh
mw-docker build --repo . --component chart --tag market-watch-chart-origin:VERSION \
  --task mw-chart-acceptance --project mw-chart-acceptance --purpose acceptance
```

构建上下文仅为advanced-host，白名单排除开发服务、缓存和其他文件。镜像显式包含range-sync等适配脚本，不包含后台代码、环境文件、账户凭据或数据库。供应商包不会通过Git分发，需要在实际构建机准备。

主站镜像也需传入隔离来源的外部地址，例如：

```sh
mw-docker build --repo . --component web --tag market-watch-web:VERSION \
  --task mw-chart-acceptance --project mw-chart-acceptance --purpose acceptance \
  --build-arg VITE_ADVANCED_CHART_ORIGIN=https://charts.example.com
```

示例域名需替换为实际配置。此参数是公开地址，不可传入token或密码。现有compose默认构建未设置该参数，正式配置需要通过构建覆盖文件传入，不能直接沿用默认开发端口。

## 静态镜像基础验收

```sh
docker run --rm -p 127.0.0.1:15187:80 --name market-watch-chart-origin-check market-watch-chart-origin:VERSION
curl -I http://127.0.0.1:15187/
curl -I http://127.0.0.1:15187/range-sync.js
```

检查CSP/Referrer-Policy/nosniff/no-store；未知资源应404，不能回退首页。用前端构建变量VITE_ADVANCED_CHART_ORIGIN指向此来源，再跑原生图表及同步验收。

## 发布约束

正式图表服务需要与主站不同origin，并与HTTPS主站使用兼容协议，不能混合HTTP内容。外部反向代理只转发静态内容，不添加API代理或凭据。主站构建时设置VITE_ADVANCED_CHART_ORIGIN；更换地址需要重新构建主站。

该配置沿用已验证开发服务的CSP：禁止网络连接，允许同源脚本、样式和blob图表iframe；不增加供应商外联权限。公开访问控制、外部TLS地址和反向代理配置在部署前另行验收。未完整供应商包的缺失资源不会被此镜像补齐。

回退时同时回退主站构建、适配脚本和对应供应商包镜像；保留旧图表入口及数据库备份。具体compose服务和生产域名尚未配置。

## 外置数据库 Compose 覆盖文件

现提供 `compose.advanced.yaml`，与 `compose.external-db.yaml` 组合；仅准备，尚未执行部署。

```sh
docker compose -f compose.external-db.yaml -f compose.advanced.yaml config --quiet
```

设置 `VITE_ADVANCED_CHART_ORIGIN` 为与主站不同的公开HTTPS origin（无路径）。`CHART_ORIGIN_BIND` 默认127.0.0.1、`CHART_ORIGIN_PORT` 默认15187；反向代理在另一容器/机器时需按真实网络调整绑定。默认绑定不会直接暴露到公网。

覆盖文件包含隔离静态服务、主站构建参数、单独低并发图表补数worker。图表worker使用外置库配置并显式禁用通知发送；原有通知worker保持原配置。本覆盖文件专用于外置库基础文件，不能直接用于内置PostgreSQL配置。

开发机已安装Docker，生产配置合并检查及本机独立验收配置已验证；外置库生产配置尚未在生产启动。不要在日志输出完整config，因为基础env_file可能包含敏感值。
