# PR #54 修复与最终复审

2026-10-12；基线 `origin/main=463b863482a908c3d7317f5e191e4f291f1a6d4a`。本目录记录 `fc9cb7d` 初始实现之后的修复工作区验收，保留上级目录原始证据及其时间来源。后端镜像标签为 `fc9cb7d` + dirty，包含此次修复；chart/web 未再修改，沿用原验收镜像。实际 ID/标签见[镜像记录](images.txt)。

## 阻塞项关闭

| 原问题 | 修复及复现结果 |
| --- | --- |
| 普通 ATR 仅检查最后参考柱，递归种子/前缀晚确认可产生过去事件 | 检查完整递归依赖确认水位并持久保存；晚确认复现返回 0 事件、warming，随后安全恢复 |
| managed 重读或 provider 成交量更新推进确认时间，真实突破漏报 | managed 使用稳定 received_at；provider 独立保存 price_confirmed_at，价格/完整性变化才推进；两类复现均产生正确的 1 个事件 |
| composite 使用收盘水位，不能证明 ATR 输入在报价之前可用 | 固定 revision/input revision 下查询递归前缀最新不可变分钟输入的真实确认时间；晚确认复现返回 0 事件、warming |

迁移 `as46_provider_price_confirmation` 接续 `ar45_market_stream`，只新增可空字段。旧行保留 NULL，保守回退 changed_at/observed_at，不猜历史首次确认时间；真实 PostgreSQL 验证幂等 upgrade 和 downgrade/upgrade。缺少确认水位的旧 ATR checkpoint 从原固定起点重建，安全恢复基准，保留次数和历史事件。[实例数据库版本](migration-version.txt)已为 as46。

composite 缓存增量确认水位；正式测试将增量与全量查询比较，覆盖范围增长、范围外新增、历史修订、origin 改变、范围缩短与旧 input revision 回退。

## 最终验证

- [扩展 Python 回归](python-tests.txt)：328 passed / 1 skipped / 33 个既有 Alembic warnings。跳过项需要 PostgreSQL。
- [最新 ATR 全量合同](atr-tests.txt)：67 passed，覆盖扩展回归启动后追加的参数用例。
- [Docker PostgreSQL 全量](postgres-tests.txt)：151 passed / 31 个既有 Alembic warnings，无 PostgreSQL 跳过。
- [PostgreSQL 增量与晚确认补验](postgres-delta-tests.txt)：5 passed / 34 deselected，覆盖全量进程启动后追加的测试。以上结果存在重叠，不相加宣称独立用例数。
- 原有 Node bridge/RPC 10 passed；本轮未修改相关 JavaScript 产品代码。修改的 Python 文件 Ruff 与 git diff --check 通过。
- [最新完整浏览器报告](runtime-browser.json)：登录实际 HTTPS 及许可图表，创建/编辑、暂停恢复、属性修改、真实鼠标拖线、刷新、关闭全部浏览器后 H4/D1 采集、一次本地通知及重启去重通过；errors 和 credentials_sent_to_chart 均为空。
- [最新 11 张截图与逐图审阅](visual/README.md)：每张均实际打开查看；只读截图阶段 errors 和 alert_writes 均为空。价格规则 ready / 第 1 次，画线规则按迟确认契约等待。对本范围功能和显示结果满意；保留长编辑标题截断的轻微旧界面瑕疵。

完整浏览器首次复跑在 ntfy 原生复选框 check 后未观察到状态变化，停止于 UI 时序断言；没有改产品掩盖该波动，第二轮完整流程通过。原始运行结果见[浏览器日志](runtime-browser.log)及[截图日志](visual-browser.log)。

## 两轴复审

使用 [code-review 技能](/home/quant/.agents/skills/code-review/SKILL.md)并行复核代码规范与实施契约。

- **Standards**：未发现阻塞项或新增文档规范违规。唯一非阻塞维护建议为 service/worker 中 managed 存储周期映射重复，可后续共享。
- **Spec**：三项 P1 已修复，未发现新的阻塞问题；普通/published/composite 确认时间、递归水位、旧 checkpoint 重建及增量证明符合契约。

## 范围和实例

quant-server Ubuntu 本机独立 project/task `mw-atr-offset-20261012`；应用 `https://localhost:17443`，图表 `https://localhost:17444`。状态见[实例记录](instance-status.txt)，启停命令见[开发记录](../../../atr-offset-alert-development-20261012.md)。实例继续保留供复核，Docker 生命周期 task 未退役；已有精确 retire preview，未 apply，未删除数据。

使用可控 Binance OHLC 与内部通知 sink，没有供应商实盘、收益回测或生产发布。凭据、env、TLS 私钥、许可资源、完整浏览器状态和私有通知日志不归档。
