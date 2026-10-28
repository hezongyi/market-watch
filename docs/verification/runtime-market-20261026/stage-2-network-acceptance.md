# 阶段2：真实容器网络验收记录

日期2026-10-27，更新2026-10-28；Ubuntu本机；任务分支 `refactor/runtime-market-stage2-20261027`，基线 `bb02c6e3`。本记录只签收列出的合同，不代表全方案或阶段2全部门槛通过。

## 环境和运行

- Compose project：`mw-runtime-stage2-20261027`，独立internal网络、数据库、schema和任务目录；不发布宿主端口。其他任务原样保留。
- PG14.24/JIT off；功能PG因既有tmpfs累积OOM曾调整至1536MiB，保留数据及失败证据。本记录不作为原768MiB性能对照。
- fixture supplier、market、independent alert、API分别为独立容器；脚本 `scripts/runtime_market_network_acceptance.py`，配置 `deploy/ubuntu/runtime-market-stage2.contracts.yaml` + `runtime-market-stage2.network.yaml`。
- `stream_c` 使用锁定旧依赖镜像和只读候选代码挂载。后来构建的probe4并未追认这些运行使用了新镜像；后续场景另记。
- REST-Batch嵌入判定使用独立project `mw-runtime-stage2-rest-20261027`、独立PG/tmpfs和新schema `runtime_network_rest_embedded_e`，probe7镜像 `market-watch-api:runtime-market-stage2-20261027-probe7`，候选工作树只读挂载。此前 `rest_embedded_a`、`b`、`c`、`d` 的失败schema及artifact保留；没有重seed或覆盖。
- OANDA解析、owner/epoch、publish、确认、组合聚合、固定指标、告警和生命周期均为实际业务实现。只替换HTTP目的地及夹具时钟；无真实账户或供应商访问，无真实ntfy。

启动示例（任务目录存在时）：

```bash
export MW_RUNTIME_STAGE2_REPO=/home/quant/repos/market-watch-runtime-stage2-20261027
export MW_RUNTIME_STAGE2_POSTGRES_MEMORY=1536m
export MW_RUNTIME_NETWORK_RUN=stream_c
docker compose -p mw-runtime-stage2-20261027 \
  -f deploy/ubuntu/runtime-market-stage2.contracts.yaml \
  -f deploy/ubuntu/runtime-market-stage2.network.yaml \
  up -d --no-deps --no-build fixture-supplier market-runtime chart-alert-runtime api
```

首次新schema必须先执行 `run --rm --no-deps fixture-seed`，随后立即启动运行容器；seed结束即启动连续业务时钟，延迟超过15秒会正确触发来源过期。不得重置时钟来隐藏来源过期。已有schema不能再次seed覆盖。

停止只列任务服务，不重建/停止tmpfs PG：

```bash
docker compose -p mw-runtime-stage2-20261027 \
  -f deploy/ubuntu/runtime-market-stage2.contracts.yaml \
  -f deploy/ubuntu/runtime-market-stage2.network.yaml \
  stop api market-runtime chart-alert-runtime fixture-supplier
```

## 已完成合同

### 最终健康修复后的检查与内嵌恢复合同

实际主机为Ubuntu `quant-server`；project `mw-runtime-stage2-five-stream-20261028`，内部地址为 `http://fixture-supplier:8080`、PG `postgres:5432/runtime_profile`，不发布宿主端口。依赖镜像probe7加候选代码只读挂载，不是最终发布镜像。PG复用且不重建tmpfs；功能预算1536MiB，不作为768MiB性能对照。

| 运行/范围 | 实际结果 | 证据 |
|---|---|---|
| `five_health28b`：最终健康修复后 | API保持停止、data-worker未启动、无独立alert；ready检查11.23秒，crossing检查26.57秒，7/7信号，六角色均有checked_at且无error。场景耗时不作SLO | `results/network-five_health28b-*.json`、`results/stage2-network-health-final-20261028.txt` |
| `five_recovery28a`：内嵌重启 | 从checkpoint8.859秒恢复，源epoch升至3，六角色boot替换，7个signal ID完全一致 | `results/network-five_recovery28a-{checkpoint,recovered}.json` |
| 同轮单角色卡住/异常 | 14.070秒仅aggregate stale；异常4.091秒可见failed，实际容器exit1、非OOM；卡住容器SIGTERM退出0 | `results/network-five_recovery28a-{stuck,failed}.json`、`results/stage2-final-source-lifecycle-20261028.json` |

历史与指标基础产物预置，不覆盖初始化和全量重建，也不是全部五个应用服务装配认证。`five_recovery28a`早于最终角色健康修复；最终源码指纹仅适用于`five_health28b`和最终回归，见lifecycle artifact。所有运行容器已停止；最终market exit0，supplier fixture默认宽限后exit137/非OOM；PG保留，任务未退役。

复用命令（schema已存在时不再次seed）：

```bash
export MW_RUNTIME_STAGE2_REPO=/home/quant/repos/market-watch-runtime-stage2-20261027
export MW_RUNTIME_STAGE2_POSTGRES_MEMORY=1536m
export MW_RUNTIME_NETWORK_RUN=five_health28b
export MW_RUNTIME_NETWORK_IMAGE=market-watch-api:runtime-market-stage2-20261027-probe7
docker compose -p mw-runtime-stage2-five-stream-20261028 \
  -f deploy/ubuntu/runtime-market-stage2.contracts.yaml \
  -f deploy/ubuntu/runtime-market-stage2.network.yaml \
  -f deploy/ubuntu/runtime-market-stage2.network-five.yaml \
  up -d --no-deps --no-build fixture-supplier market-runtime
```

停止使用完全相同的project/三个配置，把最后一行替换成`stop market-runtime fixture-supplier`。保留数据库，不执行down/重建PG。需要重跑新输入验收时使用新run/schema，并在seed后立即启动，不能覆盖上述场景。

### 之前的网络实验与功能合同

| 场景 | 实际结果 | 仓库证据 |
|---|---|---|
| 五服务目标下的market内嵌模式、API离线stream新输入 | project `mw-runtime-stage2-five-stream-20261028`，告警在 market-runtime 内嵌运行，无独立 alert 容器。首次启动时 fixture supplier 尚未监听导致初始输入过期，按生命周期合同显式 restart 后 ready；停止 API，再输入 crossing，7/7 条规则各产生唯一 Signal，market 六角色正常。检查耗时57.02秒，非单次判定时延。保留首次失败 artifact。 | `results/five-service-network-*-20261028.json` |

| 场景 | 实际结果 | 仓库证据 |
|---|---|---|
| 就绪与API离线新输入 | 7条规则；初始约8.98秒ready；API `/readyz` 200后停止且实际running=false/exit0；发送1.119后约48.39秒七条各触发一次，覆盖盘中、确认、ATR、EMA | `results/stage2-network-stream-c.txt` |
| 无浏览器/已准备产物不依赖data | 没有浏览器interest、没有data-worker容器；真实运行组推进上述新输入。历史与初始指标已准备，不能据此承诺任意序列初始化独立于data | 同上 |
| 停止并重启market+alert | 从checkpoint计9.34秒恢复；所有role boot更替，源epoch递增，规则ready，7条signal ID完全不变 | `results/stage2-network-stream-c-restart.txt` |
| 关键循环异常 | 替换聚合循环5秒后抛错，health记录failed，真实容器exit1、无OOM；原始错误不被总心跳掩盖 | `results/stage2-network-fault-exception.txt` |
| 单循环卡住 | 聚合循环不再推进，约14.16秒检查到单独stale；pricing/realtime/indicator/ownership/独立alert继续；进程仍running；SIGTERM正常exit0 | `results/stage2-network-fault-stuck.txt` |
| 父数据集/LiveState锁顺序 | pricing writer与判定、两个完整图表入口与判定/确认共6条真实PG竞态；原代码40P01，修复后6 passed/10.58秒 | `results/stage2-*-deadlock-{red,green}.txt` |
| REST-Batch嵌入告警与 close crossing | 使用probe7、隔离PG及REST协议fixture；7条close-only规则包含价格、ATR、EMA。REST candle owner恢复就绪后通过正式`restart`重建规则基线，移除启动需求lease后，market内嵌告警继续保有自身行情需求；crossing在36.18秒内使7条规则各产生1个signal、notification及outbox，无真实投递。所有规则最终`ready`，source为`candle_close_sample`、owner有效、epoch 2。初次连接supplier的3次catalog请求因启动竞态失败，随后自动重试并成功；不计为协议数据通过前的稳定启动时间。 | `results/stage2-network-rest-embedded-{control,ready,restart,demand-off,crossing}.json` |
| stale告警恢复需求回归 | 系统因输入过期暂停时保留固定revision需求，供源可恢复；显式用户pause清除该标记并释放需求。SQLite定向回归1项、隔离PG market-usage 8项；相关告警/组合PG回归总计36 passed。 | `backend/tests/test_market_usage.py`、`results/stage2-network-rest-embedded-green.txt` |

夹具产物保留在 `/home/quant/.local/share/market-watch-runtime-stage2-20261027/artifacts/network-stream_c-*.json`，包含source、role状态、rule与signal身份；不含真实凭据。

## 保留的失败和未签收范围

本次收口拓扑为五服务，后续新增的 stream 联合验收使用 `runtime-market-stage2.network-five.yaml` 覆盖此通用独立 profile 配置：`market-runtime` 内嵌告警开启，单独 `chart-alert-runtime` 不启动；测试使用新的 Compose project 与 `runtime_profile` 数据库。既有下列独立 alert 证据保留为历史对照，不代表本次部署拓扑。

- `stream_a`：seed后人工等待导致来源初始超过15秒，规则按新鲜度合同暂停；不是可用的ready验收。
- `stream_b`：新输入期间pricing publish真实40P01，发生重连与epoch变化；仅4/7触发。保留证据，不能将正确的恢复基线行为改为补发来掩盖死锁。
- 后续审查补出图表history/target反序与确认升级锁；分别在完整`chart_data`、直接`chart_page`复现。最终排序共享锁 + 确认前置排他锁通过针对性和114项PG回归；当前Standards/Spec复审无上述未关闭发现。
- REST-Batch/嵌入判定的功能网络合同已通过，但这不是完整五/六服务R2、完整五服务下重启、前台浏览器/供应商租约停止与ntfy健康巡检验收；最终同预算负载独立跟踪；这些仍按各自门槛推进。
- 这里的48秒是等待真实分钟关闭及7条规则全部交叉的场景耗时，不是单次内部判定延迟。延迟SLO使用逐输入/规则及signal monotonic证据另测。
- 尚未证明真实供应商SLA、长期容量、手机送达、真实备用源、生产切换或永久清理。
