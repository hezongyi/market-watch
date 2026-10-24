# Swing / 通知执行记录

## 边界与基线

用户已授权实施任务书；最新指令覆盖任务书的独立 preview 和 Draft PR：验收使用 $mw-acceptance，不创建 PR。
基线：v1.28.0 = 59ed3a3f3fc727da76d13149934d999ebee04218。
分支 fix/swing-format-notice-placement-20261024，worktree /home/quant/repos/market-watch-swing-notice-20261024。
风险 F0 / Ubuntu R1。真实数据、配置、数据库卷、TLS、浏览器现场保留。

## 进度

- 已读任务书、AGENTS.md、mw-acceptance；核对主机 quant-server 和实际 Docker 项目，现有长期实例15服务运行。
- 已创建隔离分支及 worktree，无既有未知变更。
- 待完成：依赖、基线保存/原生能力探针、实现、回归、CI等效检查、自审、候选提交/制品、更新长期实例并业务验收。
- 验收证据目录 /home/quant/repos/.reports/market-watch/20261024-swing-notice-implementation/。
- 不创建新数据库/空实例，不 seed/reset/migrate，不操作 Unraid，不创建 PR。

## 原生能力与实现证据

- 依赖：独立 .venv 锁定安装、editable 安装、npm ci 已完成；许可库私有副本未入 Git。
- v1.28.0 原生 widget.save / createStudyTemplate 已生成带 precision=3、颜色#123456、线宽4、单独隐藏与统计关闭的旧输入。
- 原生 inherit 实测跟随2/3/5位、手动3/5再自动、自定义 formatter；公开 precision=default 清除旧 override。旧 workspace/template 恢复、再保存恢复保留样式与输入。
- All 实测4294967295，移除轴/图例位后4294967283；仅按unsigned bitmask修改12，保留其余位。
- Swing 标签规范化在snapshot读取之前，复用study事件和既有250ms刷新；没有新增轮询。
- 本地 npm run build、独立 alert-ui build、价格格式、通知runtime/persistence、Swing固定身份/适配器检查通过；新原生浏览器矩阵正在运行。
- 新原生 fixture 为确定性合成800根行情，由真实Python算法生成；不会改共享D1或真实库。
