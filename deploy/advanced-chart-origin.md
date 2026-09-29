# 隔离图表静态来源部署准备

当前仅准备配置，尚未生产部署或完成镜像验收。

## 构建

先按现有许可安装脚本将供应商包安装到advanced-host/charting_library，再执行：

```sh
docker build -t market-watch-chart-origin:VERSION ./advanced-host
```

构建上下文仅为advanced-host，白名单排除开发服务、缓存和其他文件。镜像显式包含range-sync等适配脚本，不包含后台代码、环境文件、账户凭据或数据库。供应商包不会通过Git分发，需要在实际构建机准备。

## 本机验收（待执行）

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
