# v1.21.2 交易日历目录身份碰撞修复

正式部署 v1.21.0 前，在 Ubuntu 独立 PG14 恢复最终生产备份并调用交易日历读取时，`_runtime_rules` 对包含元数据字典的 tuple 进行默认排序。真实目录与已登记品种可拥有相同 source、symbol、ID，但价格／日历身份不同，排序落到字典比较并抛出 TypeError。v1.21.0 尚未安装，维护脚本已恢复 v1.20.4。

本次补丁只修复此部署阻塞。目录行使用 `catalog:` 范围前缀，保留已登记品种和缓存供源的原审核身份；排序仅使用 source、symbol、scope_id 标量字段。相同品种的 adjusted 与 last 行都保留且页面 row_id 唯一，不合并身份、不改变审核期限或来源适用范围。无依赖和 schema 变化，不移动 v1.21.0 标签。

新增实际 HTTP 回归用同 ID 的 Yahoo adjusted 品种和 last 目录条目复现 TypeError；修复后 HTTP 200，两种身份及唯一 row_id 保留，无审核记录保持未核实。相关日历、源范围、数据中心和会话测试 96 passed，0 failed/errors/skipped；ruff 与 diff whitespace 通过。JUnit：`verification/calendar-scope-collision-v1.21.2/regression.xml`。

第一次从 Market Watch 旧宿主虚拟环境运行相关回归时缺少 yfinance，12 项在 TestClient 清理时失败；改用 PR #46 已验证的完整依赖环境 `/tmp/mw-native-alert-python311` 后 96 项通过，没有修改依赖或把首次失败记为通过。

Standards 和 Spec 独立复核均 0 项剩余阻塞。

Ubuntu 恢复预检已通过：86 表计数和账号、通知、工作区指纹匹配，430 行日历读取成功。这次预检以 v1.21.0 镜像注入修复模块执行，最终 v1.21.2 正式镜像仍需再次实际恢复验证。Ubuntu 恢复预检使用隔离项目 `mw-v1210-restore-20261012` 和实际生产备份；正式 1.21.2 镜像、最终备份恢复以及上线结果另存生产发布清单。本文件不会把补丁源码发布视为生产部署完成。

发布操作的合并前置核对首次遇到暂未计算的 mergeable 状态；脚本未及时停止后续命令，误将 v1.21.1 标签推到 v1.21.0 的提交 56048c82。v1.21.1 不代表补丁源码或可部署版本。保留该错误标签，改用 v1.21.2；后续合并使用完整 head SHA 的条件写入，tag 只在核实 merged=true 且产品 tree 相同后创建。生产没有安装这两个失败版本。
