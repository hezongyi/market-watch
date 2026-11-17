---
title: OANDA 间歇性 401：可借鉴的处理办法
subtitle: 官方资料与公开案例 · 2026-11-16
lang: zh
template: doc
theme: paper
---

## A 调查结论

有相似公开案例，也有已合并的缓解实现。
推荐验证只读请求的有限重试，失败后再进入认证暂停。
尚未找到官方确认的统一根因或根治补丁。

## B 最接近的公开案例

[trader #624](https://github.com/rustyeddy/trader/issues/624) 报告同一有效 token 偶发 401。
其他请求成功，放慢请求后仍有复发。

[已合并补丁 #625](https://github.com/rustyeddy/trader/pull/625) 对 401 使用有限重试。
持续失败仍报告认证错误，403 不重试。
作者明确表示根因未知。

[另一个长期调查](https://github.com/huffed/trading-app-demo/pull/329)也记录多个接口间歇 401。
它没有给出已验证的修复。
这些是社区报告，不能替代本项目运行验收。

## C 官方资料能确认什么

| 问题 | 官方说明 | 判断 |
|---|---|---|
| HTTP 401 | token 无效或缺失 | 核查身份、环境与请求 |
| 请求频率超限 | 返回 HTTP 429 | 不能将 401 直接归因于限流 |
| 连接管理 | 使用持久连接；限制新连接数量 | 值得核查，但不能据此定根因 |
| token 管理 | 支持生成及撤销 | 文档没有固定过期时间 |

[错误说明](https://developer.oanda.com/rest-live-v20/troubleshooting-errors/) · [开发指南](https://developer.oanda.com/rest-live-v20/development-guide/) · [最佳实践](https://developer.oanda.com/rest-live-v20/best-practices/) · [认证说明](https://developer.oanda.com/rest-live-v20/authentication/)

## D 推荐如何处理

先记录脱敏错误信息及存在的 RequestID。
再试验原请求加两次重试，约 1 秒、2 秒退避。
这组参数是工程建议，需要验证。

连续失败后保留原认证暂停，不隐藏故障。
403、空凭据和交易写请求不套用这项策略。
若需比较新连接或不同出口，每次只改变一个因素。

## E 怎样判断有效

记录短重试恢复比例、最终失败次数和恢复耗时。
同时验证报价、已确认 K 线与告警输入。
覆盖完整交易日及开收盘边界，再判断稳定性。

反复失败时，带脱敏时间线和 RequestID 请官方定位。
本次只完成调查，没有更改代码、配置或服务。
