# XAUUSD 自建历史维护连接池超时

## 范围与结论

F0：修复数据 worker 的 Dukascopy 自有 HTTP 客户端在传输失败后无法恢复的问题；无 schema、历史格式或查询协议变更。基于实际部署的数据 worker 源码 `89b887ffe8106d362ce8d523b3e756a1fdd49cde`，只替换 `data-worker`，保留已独立部署的 Web/API/行情及通知版本。

任务 `10e5044f-8dee-4ffc-b083-2cf076a4900e` 正将 XAUUSD 历史起始范围扩展到 2021 年。原任务在 `2022-10-12 03:44 UTC` 重复超时，显式通过 `/api/market-data/tasks/{id}/control` 的 `retry` 操作也不能推进。请求审计中每次约 20 秒、0 条观测。

同容器中新客户端能取回该页不能证明任务恢复。对原进程重试并采集 Python 栈，确认 `history_network` 实际阻塞在 `HTTPcore PoolRequest.wait_for_connection`，不是在等待 Dukascopy 的历史响应；见 `original-worker-stack.txt`。低层只记录 connect/poll 等调用的跟踪与栈互相印证，该次没有新建上游连接。

使用项目固定 HTTPX 0.28.1 / HTTPcore 1.0.9 的真实代理连接池复现：代理 CONNECT 200 后 TLS 升级失败，连接可遗留为 active，继续复用该池最终得到 PoolTimeout。最小复现使用容量为 1 的真实池，第二次读取在旧实现下稳定失败；修复后同一适配器恢复。真实任务最早造成池污染的那次异常没有保留具体类型，因此不能把 TLS 场景写成已抓到的原始触发事件；已直接证实的是本地连接池无法分配连接并持续重试失败。

## 修改

- 自有客户端遇到 `httpx.TransportError` 后关闭旧池并重建客户端；下一次仍由现有任务调度、退避和游标决定，不在适配器内部额外重试。
- 旧失败页不推进游标、不写空历史，既有发布版本保留。
- 外部借入客户端保留所有权，不擅自关闭或替换；来源限流、HTTP 状态错误及内容校验也不触发池重建。
- 失败日志只记录安全的错误类、阶段、是否重建和请求时间窗口。特别区分 `PoolTimeout / phase=pool`；不记录异常原文、完整 URL、代理凭据或响应内容。

## 验证

先新增回归并确认旧实现第二次读取返回 timeout，然后修复：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest -q \
  backend/tests/test_dukascopy_history.py \
  backend/tests/test_history_versions.py \
  backend/tests/test_source_history_store.py \
  backend/tests/test_history_maintenance.py \
  backend/tests/test_history_request_evidence.py \
  backend/tests/test_provider_dukascopy.py
```

79 passed；ruff 和 `git diff --check` 通过。覆盖真实代理 CONNECT/TLS 后的连接池污染、已耗尽池的恢复、借入客户端不关闭、失败游标不推进、HTTP/限流及原生周期读取。故障注入仅用于内存假网络和单元测试，未在持久开发库注入故障。

真实 Ubuntu Docker `mw-dev`：定向部署后再次通过系统接口重试原任务，约 3 分钟持续观察中成功落库 19 页、失败 0 页，游标由 2022-10-12 推进至 2023 年 1 月；观察记录见 `observation.jsonl`；通过可信 TLS 域名访问实际认证明细接口，`task_error=null`、已发布历史仍可用、实时接续仍在收数，见 `api-proof.json`。本次只验证超时恢复与持续推进；全部多年历史补拉尚未完成。

## 部署与回退

实际主机：Ubuntu 本机 Docker。入口：`https://quant.kookvv.com:8443/m/`。

候选镜像：`market-watch-api:dukascopy-history-pool-20261117`，实际 data-worker 使用
`sha256:37320e89fa8df3195814317ba337458b589a17e86c4cf2770817559874e848af`。
旧 data-worker 镜像：`sha256:22c9c97e88e44417cba89312c2820e61bbffd62c1d86755e094606724f6694dc`。

通过 `mw-docker build` 构建；只修改 launcher 实际指向的私有配置
`/home/quant/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json`
中 `services.data-worker.image`，然后执行：

```bash
docker compose -p mw-dev \
  -f /home/quant/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json \
  up -d --no-build --no-deps data-worker
```

其他 7 个运行容器的 ID、镜像和启动时间均未变化。配置备份、前后容器快照及候选记录保存在私有目录
`/home/quant/.local/share/market-watch-dev/updates/dukascopy-history-pool-20261117/`。
回退只将该配置的 `services.data-worker.image` 改回旧镜像，再执行同一条定向 up；不要整体恢复旧配置覆盖并行任务。
诊断 helper 无业务网络或服务端口，完成后自动删除。未创建 PR、合并、tag 或部署生产；无需新 APK。
