# OANDA 有限运行会话规则复核

适用 EUR_USD、GBP_USD、XAU_USD 的 OANDA SG / v20 Practice 运行状态与调度。配置入口为 `ALERTS_OANDA_LIVE_SESSION_PROFILES`，生成器为 `scripts/oanda_live_sessions.py`。本说明不授权生产配置更新或重启。

## 审核与生成

1. 重新阅读 [SG 常规时段](https://www.oanda.com/sg-en/trading/hours-of-operation/)及 [假日安排](https://www.oanda.com/sg-en/trading/holiday-trading-hours/)，保存获取时刻、适用实体与所选日期。常规表只支持生成器的三个白名单品种；若窗口有特殊安排，先核实并显式表达特殊闭市，不能直接使用常规表输出。
2. 从私有部署配置核对完整身份：`source=oanda`、`channel=v20`、`environment=practice`、精确 `provider_symbol` 和不透明 `account_scope`。scope 不提交、不写入报告，也不使用实际账号代替。
3. 选有时区且不超过七天的审核窗。到期前重新核对官方证据；跨 DST 时核对纽约当地时间与 UTC 的换算，跨假日时核对对应日期。不得只延长旧配置日期或自动无限续期。
4. 在私有目录生成候选。以下 scope 为占位符，实际参数由私有配置读取；避免将真实值放入共享日志或命令历史。

   ```bash
   .venv/bin/python scripts/oanda_live_sessions.py \
     --account-scope '<opaque-account-scope>' \
     --reviewed-start '2026-10-24T00:00:00+00:00' \
     --reviewed-end '2026-10-31T00:00:00+00:00' \
     --symbols EUR_USD,GBP_USD,XAU_USD \
     --output /private/task/session-profiles.candidate.json
   ```

   示例日期到期后必须重新选窗。输出权限为 0600；父目录应仅任务所有者可访问。

5. 脱敏核对候选与旧配置：品种、revision、审核窗、时区、每周闭市范围、特殊闭市、完整身份是否一致。报告只记录身份匹配结果，不记录 scope 原值。

## 判读与验证

FX 的官方纽约时间为 17:05–16:59，黄金为 18:05–16:59。实现只确认完整闭市内部，收市分钟及复市前边界仍为 unknown；`next_session_at` 指闭市内部结束边界。`scheduled_open` 只代表计划，不证明报价或 M1 可用。

来源状态 `session_configuration.profile_reason` 的含义：

| 值 | 处理 |
| --- | --- |
| `missing_profile` | 缺少有效配置，按上述步骤准备有限候选 |
| `identity_mismatch` | 核对五项完整身份，不能跨账户或品种套用 |
| `outside_reviewed_window` | 重新取证并生成新窗 |
| `boundary_minute` | 保留 unknown，等待实际探测，不改成 closed |
| `null` | 当前分钟规则可判读，仍需独立检查来源与确认健康 |

本地代码检查：

```bash
.venv/bin/python -m pytest -q backend/tests/test_live_session.py backend/tests/test_confirmation_session.py
```

这些检查默认使用隔离 SQLite 和合成 HTTP transport。真实 PG、worker 场景与原生浏览器属于验收阶段，须按本次用户授权执行；本地通过不等于 R1 通过。

## 应用与回退边界

应用之前保存当前有效配置和镜像引用，核对候选未到期、只改变运行覆盖，取得本次生产配置应用授权。按现有部署入口展开 Compose 并核对实际 Settings；不要更改历史 `MarketDataset.identity`、价格或组合修订。

配置回退使用留存的上一份配置及对应镜像，仍需遵守生产操作授权。如果旧审核窗已过期，回退后应显示 unknown，不能把过期配置当作已验证时段。保留已有确认事故和未读记录；闭市调度正确不代表旧事故已恢复，真实确认回补由现有链路处理。
