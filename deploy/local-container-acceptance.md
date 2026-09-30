# Ubuntu 本机容器验收

此流程只用于开发验收，不是生产发布命令。2026-09-30已验证Docker29.1.3和Compose2.40.3。

## 隔离边界

- Compose项目：`market-watch-acceptance`，独立默认网络。
- 服务：API、图表历史worker、主站、图表静态来源、TLS代理。
- 端口仅绑定本机：主站15443、图表15444、静态HTTP15187。
- API/worker通知发送强制关闭，数据库各最多1连接；使用开发库，勿传入生产env。
- 不包含原行情采集/通知worker，这些原服务的完整部署配置仍是compose.external-db.yaml；本配置验收新增图表栈，不宣称替代全部服务部署。
- 本机证书为自签，仅用于验证HTTPS跨来源机制；不代替正式域名/证书链验收。

## 当前已构建镜像

- `market-watch-api:acceptance-412703c`
- `market-watch-web:acceptance-412703c`：构建参数VITE_ADVANCED_CHART_ORIGIN=https://127.0.0.1:15444
- `market-watch-chart-origin:acceptance-412703c`
- 回退样本：`market-watch-chart-origin:acceptance-2e35aa7`

镜像由原Dockerfile构建；供应商包仍不提交Git。DockerHub直连超时的本机通过已授权代理获取基础镜像，再docker load导入；没有修改系统Docker代理配置。

## 配置及启动

当前本机临时目录`/tmp/mw-docker-acceptance`含受限api.env、tls.conf、cert.pem、key.pem。这些文件不入Git，重启清理/tmp后需重新生成。api.env来自开发配置，并覆盖delivery_enabled=false、cookie_secure=true、public_url=https://localhost:15443。权限600，数据库必须检查为开发库。

```bash
export MW_API_IMAGE=market-watch-api:acceptance-412703c
export MW_WEB_IMAGE=market-watch-web:acceptance-412703c
export MW_CHART_IMAGE=market-watch-chart-origin:acceptance-412703c
export MW_ACCEPTANCE_ENV=/tmp/mw-docker-acceptance/api.env
export MW_ACCEPTANCE_DIR=/tmp/mw-docker-acceptance

docker compose -f compose.acceptance.yaml config --quiet
docker compose -f compose.acceptance.yaml up -d --wait --wait-timeout 90
```

若旧会话未刷新docker组，使用`sg docker -c '...'`执行Docker命令即可。env_file采用format: raw，防止密码哈希中的美元符号被Compose替换。不要打印完整Compose配置或env内容。

主站为https://localhost:15443，图表为https://127.0.0.1:15444，使用不同主机名避免会话Cookie共享。本机浏览器测试为web/tests/advanced-container-https.browser.cjs，显式接受测试自签证书，检查登录/图表/M15/保存及静态来源无凭据。

## 图表版本回退及恢复

```bash
export MW_CHART_IMAGE=market-watch-chart-origin:acceptance-2e35aa7
docker compose -f compose.acceptance.yaml up -d --no-deps chart-origin
docker compose -f compose.acceptance.yaml restart tls
```

TLS代理重启用于重新解析被替换容器的地址。检查/viewports.js与目标提交逐字节相等，再运行浏览器验收。恢复时将MW_CHART_IMAGE改回当前标签，执行相同命令。不回退数据库；数据库迁移回退另在独立PostgreSQL schema验收过。

## 清理

仅执行本文件项目的`docker compose -f compose.acceptance.yaml down`。不执行全局prune，不删除其他项目容器、镜像或卷。验收期间旧8004开发API及Ubuntu历史worker已停止以避免重复连接；恢复原开发服务前先停本验收API/worker。
