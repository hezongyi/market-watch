# #51 合入后的集成证据

本轮针对已合入 main `33ef507` 的 #51 与 #50 兼容性；merge commit `0b0eef0` 保留 metadata labels 与 Swing strength 名称。实际 native Dukascopy ticker 大写导致 origin 查询失败的 bug 已修复，按规范系列身份查找；Dukascopy 告警日历未核实仍禁止提交。

实际环境：Ubuntu `quant-server`，独立 Docker task/project `mw-ux-acceptance-after51-20261012`，loopback 网页 19991、chart origin 19992，独立 `production_ux_acceptance` 数据库／PG volume。价格缓存明确合成，应用／API／数据库／许可原生图表均实际运行。镜像经 `mw-docker build`、builder `market-watch-ubuntu` 构建，chart origin 修复后重建；复现命令见[总报告](../../../production-ux-fixes-20261012.md)。本任务退役后这些地址停止服务，重建需新任务身份。

| 证据 | 实际验证 |
| --- | --- |
| [after51-results.json](after51-results.json) | 同图 MACD 19/35/11＋Swing 3/7、Added 摘要、实际模板 UI 保存／应用、工作区保存／整页刷新、持久化模板重应用、大写 Dukascopy ticker 的真实告警对象入口 |
| [native-results.json](native-results.json) | BTC Python 对象入口 origin／POST201／保存快照独立性、手选参数 POST201／reload、股票／日历、既有 reset；9 项检查 |
| [results.json](results.json) | 375／390／844 触摸取消、POST201、刷新绑定与焦点；实际三 current workers running，legacy disabled |
| [checks.json](checks.json) | 299 Python、24 PostgreSQL、指标 JS／7 bridge、构建；12 能力组 local-file probe 与 Docker 验收范围分开记录 |
| [visual-review.json](visual-review.json) | 14 张逐张打开复核的截图、尺寸、SHA256及各自证明范围 |
| [cleanup.json](cleanup.json) | 本任务精确预览／apply 退役，实际恢复后逐表行数／内容校验与资源归零 |

截图依次覆盖 integrated-added-indicators、integrated-template-save／applied、integrated-workspace-reloaded、integrated-dukascopy-alert-origin、native-indicator-actual-values、python-object-alert-1366／snapshot、python-alert-saved-independent、manual-alert-parameter-snapshot、alerts-reloaded、watch-375／390／844。

模板组合验证的 Swing 显示参数为默认 true／below_name，未自定义样式。其他 Swing 显示切换、多实例／双图、旧八指标兼容只属于注明的 local-file 能力复验。MACD 数值曲线以 applied／workspace-reloaded 图为证；Added 与保存对话框截图主要证明标签和操作，不能单独证明曲线加载。alerts-reloaded 只证明列表重载；两条参数快照由 API／DOM 断言核对，不宣称告警已附着到截图中的不同品种工作区。

行情与来源 marker 为本任务合成数据，截图的时段未核实状态保持可见。未验真实上游价格、告警 worker 端到端判定、通知、实机／Safari或生产部署。原完整 UX／演练／四角色 stop-recovery 验收保留于 [round2](../round2/README.md)，本轮没有重复其全部操作。无密码、Cookie、CSRF、供源凭据、许可库或私有数据库归档入库。

## Standards

独立规范审查：合并标签策略及 canonical origin 查询符合写入键约定，无硬性标准或安全阻塞。资产类别全集分散为既有低优先级维护建议。最终脚本已将本轮 reset 来源写为 BTC→股票。

## Spec

独立需求审查：#50 参数可读性与 #51 Swing fallback／计算契约兼容；Dukascopy 来源限制保留，BTC 真正提交／持久化通过。组合模板只覆盖默认 Swing display 选项，未扩大为自定义显示／样式验收。完整原 UX 结论继续引用第二轮。

两轴均无交付阻塞；本轮无生产合并或部署。
