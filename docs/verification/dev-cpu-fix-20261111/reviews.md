# 独立 F1 审查

2026-11-11，依据 AGENTS.md 的 F1 要求，由两个独立代理只读审查相对
v2.0.6 / d2a3e092 的实现与回归。

Standards：无阻塞项。Instrument 串行化及原锁顺序保持；只有除 observed_at
外完全一致的快照走快速刷新；价格、成交量、确认和完整性差异保留普通发布；
尾柱信号为索引范围 LIMIT 1，未增加全历史扫描；shadow 未削弱请求幂等校验，
unchanged 不产生激活 verdict，也不解锁保留清理。diff check 与定向 Ruff 通过。

Spec：最终通过，无待修问题。初审指出 120 分钟数据不能证明 D1/W1/MN；已补
三个周期必须存在的断言、派生观测时间推进和行 revision 稳定断言，并通过真实
PostgreSQL 参数测试覆盖。原 queued publication 代际和失败回滚测试改用真实
成交量修订，纯观测原子提交另有回归。数值缓存与网页可见 freshness 分开读取，
实时流包含尾柱观测信号。

审查为静态结论；实际 PostgreSQL 回归及部署/性能结果单独记录。
