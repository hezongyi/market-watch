# 独立 review 复核记录

2026-10-24，当前实施工作树；只读 review，未启动 Docker 或接触长期验收实例。

| Review | 发现 | 复现与修复 | 复核 |
| --- | --- | --- | --- |
| Spec P1 | 未到期 unavailable/stale 被统一 inherited，零行产物缺失导致永久 deriving | 继承父真实 status/error/observed_at/last_success，无内容 unavailable；成功继承保留 inherited_version；全失败仍失败 | 原发现关闭；22 tests passed。额外内存场景确认成功继承 provenance、request_count=0、active 清除 |
| Spec P2 | 小周期只复查末两根，漏窗口内历史修订 | 删除末两根裁剪；由来源限制真实可得窗口，合并保留旧历史 | 第 3 根 M5 修订用例由红转绿；原发现关闭 |
| Spec P2 | 独立起点被顶层 target_start 截断 | 默认 update 使用 frame targets，版本包络含最早 frame；显式 update/backfill/recheck 用固定区间 | 普通独立起点与完整显式 backfill 额外验证通过；原发现关闭 |
| Standards P2 | 旧 M1 bounded-m1-read-v1 审计 checksum 被 timeframe 改变 | record 默认旧 FIELDS；snapshot/report 按 schema，仅 v2 编码 timeframe | 旧最小 checksum 恢复原值；5 evidence tests passed；原发现关闭 |

独立修复复核未发现新增明确违规。以上仅为代码及 fixture；PG14.24、迁移恢复、部署浏览器仍未执行，不能替代实际验收。
