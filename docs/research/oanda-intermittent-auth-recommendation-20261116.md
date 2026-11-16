# OANDA 间歇性认证：网上案例与项目建议

调查日期：2026-11-16。基线：main / v2.0.12，`2c984298261898fef40867ea01dad79cbdc2770a`。本轮仅研究、读代码及既有证据；没有调用用户上游账户、修改实现、重启服务或改变配置。

## 结论

网上有与本项目相似的“同一有效 token，部分请求 401、其他请求成功”记录，也有已经合并的有界重试实现。它提供可验证的缓解方向，但没有证明 OANDA 的根因，也没有长期生产稳定性证据。官方没有给出间歇性 401 的统一修复。

推荐先完善少量错误证据，再对只读行情请求验证“最多三次总尝试，间隔退避，仍失败才进入原认证暂停”。不要盲目换 token、无限重试或把真实 401 隐藏成正常。重建连接只做对照实验；不能预设连接池就是原因。

## 公开案例

### 与本项目最相似的缓解实现

- [rustyeddy/trader #624](https://github.com/rustyeddy/trader/issues/624)，2026-11-14：作者报告两次 smoke 中，同一 token 有一条 `Insufficient authorization` 401，而其他请求成功；加入 500ms 请求间隔后仍发生。
- [#623](https://github.com/rustyeddy/trader/pull/623)：放慢请求；作者明确写无法证明它消除了单次 401。
- [#625](https://github.com/rustyeddy/trader/pull/625)，2026-11-14 已合并：401 纳入既有有限重试；403 和空 token 不重试；持续 401 仍作为认证失败。代码和测试在合并 SHA `354c121c3fae488aaae2c66f8fc41fc6535bc34e` 可核查。
- 已检查 PR diff：测试覆盖 401→200 成功、持续 401 最多三次、403 不重试、错误文本不含 token。作者明确承认偶发 401 原因未知。

证据等级：社区作者一手报告和公开实现，非 OANDA 官方结论；测试以模拟响应为主，不能视为真实长时间运行验收。可借鉴边界，不照搬所有状态分类或参数。

### 有类似长期记录，但没有已证修复

- [huffed/trading-app-demo #329](https://github.com/huffed/trading-app-demo/pull/329)，2026-11-07 已合并的调查文档：candles 与 positionBook 均出现同 token 间歇 401；有跨周统计。
- 作者同时保留“上游负载、其他客户端、限制策略”等假设，未证明。不能把其整点分布当成本项目原因，也不能采用其其他数据源回退来替代本项目来源语义。

有限公开检索没有找到官方确认的通用根治补丁。Google 返回脚本跳转、DuckDuckGo 验证挑战，未将不可读搜索摘要用作证据；主要依据直接可读官方页面和 GitHub issue/PR API。

## 官方约束

详见 [官方来源核查](oanda-auth-official-sources-20261116.md)。

- [错误说明](https://developer.oanda.com/rest-live-v20/troubleshooting-errors/)：401 是认证无效/缺失，需核查 Bearer、URL、账户；403 是权限问题。
- [开发指南](https://developer.oanda.com/rest-live-v20/development-guide/)：REST 超过 120 请求/秒/IP 返回 429；新连接不超过 2/秒；stream 不超过 20/IP。不能把 401 等同于 REST 请求限流。
- [最佳实践](https://developer.oanda.com/rest-live-v20/best-practices/)：使用持久连接，推荐既有连接不超过 100 请求/秒。官方没说“重建连接必定修复 401”。
- [认证说明](https://developer.oanda.com/rest-live-v20/authentication/)：可生成和撤销个人 token；未写固定过期时间或自动 refresh 流程。不能宣称定期过期，也不能保证永不过期。

## 本项目为什么值得试有界恢复

以下是 2026-11-16 既有观察和基线代码，非本轮重新采样：

1. [先前正式流记录](../verification/realtime-auth-recurrence-20261116/README.md)有探测成功后正式连接再次 401；同凭据代理和直连独立探针均有成功。独立进程用新连接，不能代表正式连接恢复，更不能排除代理故障。
2. 最近部署验收先观察四品种恢复，跨分钟时 EURUSD 确认再次 unauthorized，而报价仍更新。这证明流式报价和新 REST 确认请求应分别判断。
3. `backend/alerts/oanda_stream.py:175` 的 `rest_get` 仅在可重试网络异常时淘汰池；HTTP401响应返回后由上层判错。确认请求没有单次操作内的401短重试。
4. `backend/alerts/oanda_stream.py:400` 的正式 stream 每次 attempt 已用新池且结束关闭。因而“给 stream 加新池”不是新方案；stream 与 REST 池应分开实验。
5. `backend/alerts/live_pricing.py:212` 的 unauthorized 退避使用 `oanda_auth_probe_seconds`；`config.py:104` 默认及最小300秒。
6. `live_pricing.py:857` 的确认401使对应品种 `next_confirm_at` 延后；stream模式保留独立报价，rest_batch模式还会暂停账户采集。不是所有401都立刻暂停全部品种。
7. `market_contracts.py:207` 把401、403都归入 `unauthorized`。若新增短重试，必须在仍能看到原HTTP状态的传输/adapter层判断401，不能简单重试所有 `unauthorized`。

## 建议的最小验证路径（未实施）

1. **记录失败原因。** 为401保存UTC、角色、操作、允许列表内的错误码/消息、存在的RequestID、匿名凭据版本和连接代次。不要记录完整账户URL、token、请求头或任意未经清洗的响应正文。
2. **只读请求有限重试。** 建议实验参数为原请求加两次重试，约1秒/2秒退避带小抖动，总耗时受操作deadline、取消和现有request slot约束。这是待验证参数，不是OANDA官方参数。
3. **保留失败语义。** 403、空凭据不做该短重试；最后仍401才走原有认证暂停。stream仅重试尚未建立的握手，不重放已消费事件；REST重复相同窗口。禁止直接套用下单/交易接口。
4. **按证据决定连接/出口调整。** 比较原REST池、受控新连接及当前代理/直连的同参结果；每次只变一个因素。遵守新连接限额，不批量频繁重建池，不自动切到其他行情来源。
5. **用真实后台验收。** 统计原始401数、短重试恢复数、最终失败数和恢复耗时；同时检查quote序号、确认M1前沿、积压补齐和真实可运行规则。覆盖至少一个完整交易日及一次开收盘边界，记录覆盖时间；不能只用401→200 mock或单次探针宣布修复。
6. **持续出现则请OANDA定位。** 使用脱敏时间线和RequestID，通过官方支持提交。不发送token；本轮没有联系任何人。

本轮没有运行代码测试，因为没有代码修改；官方URL、公开PR合并信息、diff和项目行号已回读核对。没有新CI、PR、tag或部署。
