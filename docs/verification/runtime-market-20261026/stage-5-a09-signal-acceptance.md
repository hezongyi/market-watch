# A09 慢源期间的信号级验收

日期：2026-10-28。PR #113 的补充验收，继续使用五应用服务方案；本场只启动 market-runtime、data-worker、notification-worker 三个后台组，以及任务 PG、合成供源。API/web 未启动。无产品代码或 schema 修改。

## 环境与证据

- 主机：Ubuntu `quant-server` 本机 Docker；无远端转发，无宿主端口。
- project/task：`mw-stage5-a09-20261028` / `stage5-a09-20261028`。
- network：`mw-stage5-a09-20261028_default`，实际 `Internal=true`；volume：`mw-stage5-a09-20261028_runtime-topup-postgres`，保留。
- 产品源码：`e13b57b8eb77b9839813a9a9e671e6e00f18ec68` 的只读 `git archive` 快照。新增验收探针使用 `2b29bf93`，只读挂载到 `/stage5`；运行时产品模块未变。
- 复用 `runtime-stage5-topup.acceptance.yaml` 的锁定应用依赖镜像和 PostgreSQL 14.24 digest；不重新构建产品镜像。
- 原始文件：`/home/quant/.local/share/market-watch-stage5-a09-20261028/artifacts/`。脱敏摘要、源码归档/探针 SHA256 及原始文件 SHA256：`results/stage-5-a09-signal-20261028.json`。
- 供源：OANDA/Binance 与 catalog 经本地 fixture；Dukascopy 测试订阅指向永不回应的 stub。无生产凭据，`ALERTS_DELIVERY_ENABLED=false`，无 ntfy topic。没有真实供应商或真实通知访问。

## 报价流诊断与基线

旧批次供源重建后报价年龄不断增加，规则已自动暂停，因此其 signals=0 不能证明慢源期间仍能判定。本轮先用 `check-source.py <label>` 读取实际 LiveState，断言 owner 有效、ready 且报价年龄小于15秒；该脚本通过本项目 `probe snapshot` 读取数据库。

在持续运行 market-runtime 的情况下，执行一次 `up -d --force-recreate --no-deps fixture-supplier`。重建前报价年龄321 ms；重建后的两次检查分别224 ms、322 ms，revision 11→71→182，market boot 不变。**本次没有复现长期断流，旧问题根因仍未定性，没有修改产品重连逻辑。** 保留该组诊断快照，不宣称已修复旧批次的所有重连条件。

供源中断期间已暂停的规则需要正式 restart 才能重新建立判定基线。本轮 `a09 prepare`：

1. 确认 source owner 有效且报价新鲜。
2. 用 `chart_alert_service.lifecycle` 暂停其他规则，并只 restart 一条价格 intrabar cross_up 规则。
3. 等待真实 monitor 将其推进到 active/ready、count=0，确认基线价格 `1.110 < 1.115`。不手写 ready、判定状态、signal 或 Outbox。

## 执行命令

在仓库根目录执行。paths.env 指向本项目独立 snapshot、harness、artifacts，并设置 task/project 标签；首次创建的 artifacts 目录需允许镜像 app 用户写入。

```bash
C=(docker compose --env-file /home/quant/.local/share/market-watch-stage5-a09-20261028/paths.env \
  -p mw-stage5-a09-20261028 -f deploy/ubuntu/runtime-stage5-topup.acceptance.yaml)
"${C[@]}" up -d --no-build postgres
"${C[@]}" run --rm --no-deps fixture-seed  # 全新任务库只 seed 一次
"${C[@]}" up -d --no-build fixture-supplier market-runtime data-worker notification-worker
# 本轮供源重建诊断发生在 prepare 之前；慢源验收中不重建供源/服务/规则。
"${C[@]}" run --rm --no-deps probe a09 --phase prepare --seconds 30
"${C[@]}" run --rm --no-deps probe slow-source --phase on
"${C[@]}" run --rm --no-deps probe a09 --phase fault-ready --seconds 45
"${C[@]}" run --rm --no-deps probe a09 --phase crossing --seconds 20
"${C[@]}" run --rm --no-deps probe slow-source --phase off
"${C[@]}" run --rm --no-deps probe a09 --phase released
"${C[@]}" run --rm --no-deps probe supplier-state
"${C[@]}" stop -t 30
```

探针：`scripts/acceptance/stage5_a09_probe.py`，由 topup 入口调用。断言不满足时命令非零退出，原始 snapshot 保留。

## 实际结果

- `prepare`、`fault-ready`、`crossing`、`released` 四阶段均返回 `passed=true`。
- 独立 Dukascopy 订阅实际出现 `ReadTimeout` 后才发出穿越报价；fixture 最终观察到7次慢请求。
- 通过真实 HTTP fixture 输入 `1.110 → 1.119`，穿越阈值 `1.115`。
- 穿越后20秒窗口共38个采样，全部保持 `ReadTimeout`；健康 OANDA 源 owner 有效、ready，最大报价年龄 **584 ms**，revision **812→852**。
- 所有后台角色 boot ID 与基线一致；被测规则的 run、version、control_revision 不变，始终 active/ready。故障窗口内没有 restart、rebaseline 或配置更改。
- 真实业务链由0推进到各1条，之后保持不变：

| 记录 | ID | 关系 |
|---|---|---|
| ChartAlert | `284653a0-77a7-4b53-a2f2-18bfa52045ed` | count 0→1 |
| signal | `fd508cfb-f884-44da-80d9-a017be23e501` | chart_alert_id 为被测规则 |
| notification | `c2d2d95c-d599-42e7-8430-45921fef2dc0` | kind=signal，关联该 signal |
| Outbox | `84eb0be6-38e3-43a0-95c7-57c99ff08dff` | 关联该 notification，仅一行 |

撤销慢源订阅后，健康源 revision 继续增加，signal/notification/Outbox 的 ID 集合保持不变。此处撤销的是故障注入订阅，**未验证 Dukascopy 恢复取得真实数据**。通知未实际发送，fixture 的成功通知投递计数为0。

## 签收边界

A09 信号级缺口关闭：一个独立来源持续超时时，其他来源的报价与真实告警判定继续，并形成唯一持久事件链。错误/等待/休市区分沿用旧补证中明确列出的来源错误和已核实日历证据；OANDA 1970业务时钟下的 unknown 不表述为休市。

本场只有一条价格 intrabar 规则，不代替原阶段合同的 close/EMA/ATR 语义覆盖，不作为延迟 SLO 或长期容量测试，也不覆盖告警依赖本身失效后的自动切源。A08 仍保留既决非阻塞偏差，轨道 C 另行交付。

所有任务容器已停止；卷和原始证据保留，不删除旧项目、生产资源或永久数据。
