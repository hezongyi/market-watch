# 修复验证证据

**最终交付以[第二轮完整证据](round2/README.md)为准。以下为第一轮历史结果；其Python入口限制已在第二轮补齐，原文件保留。**

全部新增证据来自Ubuntu独立实例或注明的fixture，历史生产报告未改。

- [逐项结论与范围](../../production-ux-fixes-20261012.md)
- [真实手机visualViewport测量、保存、刷新与绑定](results.json)：watch-375/390/844.png
- [独立worker真实停止300秒及恢复](health-stop-recovery.json)：health-stopped.png、health-current-recovered.png
- [真实原生UI结果](native-results.json)：native-indicator-actual-values.png、manual-alert-parameter-snapshot.png、dukascopy-stock-filter.png、calendar-independent-targets.png、manual-scale-restored.png。行情为合成缓存，不能当供源验证。
- [演练任务默认收起及结果优先](replay-results.json)：replay-result-priority.png
- [120项首页fixture检查](home-fixture-results.json)
- [日历／告警／演练组件fixture](panel-fixture-results.json)
- [测试与未验证范围](checks.json)
- [清理与实际恢复证明](cleanup.json)

不含密码、Cookie、CSRF、私有账号或许可库源码；截图仅为独立验收界面，账户范围是合成fingerprint。
