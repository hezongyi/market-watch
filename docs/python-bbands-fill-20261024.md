# Python布林带上下轨填充

用户要求Python布林带像内置布林带一样，在上下轨之间显示底色。P0样式调整，补充Ubuntu R1视觉验收；只改`advanced-host/indicators.js`的BBANDS展示元数据。

独立分支`feat/python-bbands-fill-20261024`，worktree`/home/quant/repos/market-watch-bbands-fill-20261024`，由上一轮收口`552b555b`派生，保留Supertrend精度、Swing及全局右下角通知。

## 实现与本地核对

- 使用原生`filledAreas`，连接既有upper/plot0与lower/plot2，不增加输出序列或数值计算。
- 默认`#2196F3`、透明度95、开启，与本机许可库内置Bollinger Bands实际样式一致。
- 原生样式页提供Bands Background的颜色、透明度和显示开关；`fillgaps:false`，不跨无值区强行填充。
- 真实许可库视觉探针验证深/浅主题开关填充会改变画布像素，K线及三轨保持清晰；自定义颜色与透明度保存恢复通过。
- 旧版本真实save/template API生成的BBANDS工作区/模板恢复后自动获得默认底色。
- 既有价格格式、Supertrend映射和指标身份3项Node合同通过。样式变更使用直接视觉核对，不新增镜像实现的单元测试。

继续使用现有mwa，仅构建/替换Chart，保留其余14服务、真实数据、完整私有配置和保护浏览器。入口：<https://192.168.7.232:18280/advanced-charts/mw75-real>。

已更新并验收通过：产品提交`09b8ba141804377252183aa84fc96eebe6ea0d0c`，Chart镜像`sha256:a46ca3bd8edaa704cdffc9a5f334467752f90e49ca03d1621f61ce97bc173117`，dirty=false。实际mwa EURUSD上下轨间底色可见，原生样式页Bands Background控件可见，三轨仍显示五位价格，pageerror=0。

15容器运行/API与PG healthy/restart=0；其余14服务身份及全部配置保持。6张持久表数量与完整行哈希相同，保护浏览器ID及启动时间相同。长期manager固定Chart引用已同步，实例继续运行。

仅本轮Chart运维：`python3 /home/quant/repos/.mwa-bbands-fill-20261024/operate.py start|status|stop|audit`；实际未stop/rollback。完整证据及精确回退：[results.md](/home/quant/repos/.reports/market-watch/20261024-bbands-fill/results.md)。未重跑全套CI、全部指标数值或Swing/通知浏览器矩阵；不PR/push/合并/生产发布或操作Unraid。
