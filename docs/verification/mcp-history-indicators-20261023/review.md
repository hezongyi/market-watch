# 本人自审

分类 F0，最小检查按仓库 AGENTS.md 选择。组合依赖沿用 PR #94，不修改其工作树。

- 输入扩展仅在 IndicatorsQuery；报价/K 线输入、权限、工具名和数量不变。
  版本 UUID/MWH 复用 chart_series.decode，拒绝错误类型与无意义的旧参数。
- 复用 chart_api.query_chart → series_access → fixed_indicators。
  不新增指标算法、历史下载、worker、版本存储、快照回放或数据库迁移。
- 先验证全部固定指标 spec，再允许共享读取注册任务；避免一组参数中部分非法却留下任务。
- 价格版本、checksum 和 input_manifest 来自指定父版本；指标 input_evidence 指向同一版本。
  发布新版本不会改变显式版本输入。缺失/未发布/回收/无周期明确返回 DATA_UNAVAILABLE。
- 历史输入的 null、pending 和 partial 沿用共享语义；保留 K 线确认/闭合/覆盖、逐点依赖及临时标记。
  固定输入不会因所有值为 null 而被错误替换成 INSUFFICIENT_HISTORY。
- 缺口判断使用实际品种与日历 profile；UUID 不能被当成品种代码判断黄金交易时段。
  指标 point time 与分页均使用 UTC start，图表标签单独保留。
- 临时测试容器网络隔离，不读其他实例数据库；R1 配置专用数据库、网络、volume、凭据和端口。
  验证脚本先校验运行归属；证据不含 token/headers。没有生产、合并或永久删除操作。

限制：版本及周期须已发布；冷请求可以只返回价格和进度。明确指定历史版本不等于新增跨调用
回放协议。跨工具组合工作流、通用输出/错误重构继续作为独立范围。

R1 受到 Ubuntu 启动负载门槛限制，实际执行前不得宣称验收完成。最终结果见 results.md。
