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

## 自审与回归补充

- 窄屏截图发现旧 host 统计卡片盖住原生通知：统计卡片改挂在原生图表文档，保持pane坐标和样式，通知/菜单通过同一stacking context正确覆盖。新增真实elementFromPoint覆盖断言；未隐藏统计或改动其开关。
- 现有Swing原生回归整套通过：四绘图、桥接、统计、隐藏、参数、候选撤回/确认、多实例、双图、375px浅色和原生模板。旧测试硬编码8个study，而当前catalog已扩展；改为比较实际保存前的catalog数量及完整输入，不跳过旧study兼容性。
- 本地CI等效：53条Node命令、6条CI浏览器命令、97项工具链/66 subtests、14项分类测试、4份Compose展开、构建和Ruff均通过。
- CI固定PostgreSQL14.24 policy测试8项通过（76.78s），使用独立Compose project `mw-swing-notice-ci-20261024`、回环18789、tmpfs、384MiB/0.25CPU；与长期实例数据库完全隔离。测试结束已停止，只保留已停止容器及配置，不触碰长期数据。backend_changed=false，按CI分类跳过后端全量。
- 用户要求不提交PR：不push、不创建PR、不触发远程GitHub CI；以上明确为本地CI等效检查。
- 第一轮Chart构建为01b9d93d，尚未部署；统计层级修正提交后必须重建Chart，最终验收不得使用旧镜像。
