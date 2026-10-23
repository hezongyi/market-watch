# 取消右上角指标状态窗口

用户于 2026-10-22 将需求收敛为“直接取消这个窗口”，并明确授权修改。此前讨论的指标旁状态标记、详情改版和新入口不再实施。

- 风险分类：**P0**，删除局部展示及其专用前端状态，无 API、数据库、计算政策或持久格式变更。
- 产品提交：`b839990`，基于集成 `5cb6a8e`。
- 开发分支：`fix/mwa-remove-indicator-window-20261022`。
- 工作树：`/home/quant/repos/market-watch-remove-indicator-window-20261022`。

## 改动

删除右上角“图格指标状态”窗口、专用 CSS、前端状态汇总及接收处理。历史加载详情的空状态只取决于实际历史任务，避免因已取消的指标状态留下空白详情。

指标计算、原生图表及 Swing 统计卡片、系统故障消息、自动恢复和已有 bridge 重试命令保留。随窗口移除其“重试指标”按钮；不另建入口。两个旧浏览器脚本同步改为检查原生参数过渡／bridge 恢复，不再引用已移除的窗口，也不再将程序触发恢复描述为用户点击。

## 验证

- `mw-docker build` 完成 Web TypeScript 检查和生产构建。沿用既有 bundle 大小提示。
- `node tests/indicator-runtime-contracts.cjs`、`node tests/indicator-snapshot-recovery.cjs` 通过（在 `web/` 中运行）。
- 更新的 issue89 浏览器脚本通过语法检查；此次未重建该历史隔离实例或执行其完整故障注入流程。
- `advanced-python-indicators.cjs` 存在 `chartDisplayBatches is not defined`；`indicator-retry-failure.cjs` 存在状态断言失败。两项均已在原集成 `5cb6a8e` 复现相同失败，本次未修改相应运行代码和测试文件。首次调用部分脚本使用了错误 cwd，修正至 `web/` 后才做上述判定。
- [真实登录浏览器记录](browser.json)：自建／组合 EURUSD 日线的 Swing、EMA、RSI 都有有效原生数值；深浅主题 × 1440/390/375px 均无该窗口；刷新后指标恢复；历史加载详情可打开；服务端工作区前后完全相同，无未捕获浏览器异常或指标 HTTP 失败。
- 浏览器使用全新临时 context；拦截工作区／偏好保存，并仅在该临时页面停止自动保存计时器，避免测试编辑保存到用户工作区。正常行情读取、计算需求及缓存仍可写入，不宣称数据库零写入。受保护浏览器未连接。

## mwa 更新与回退

Ubuntu `quant-server`，现有 Docker project `mw-issue75-v2-20261018`，入口 `https://192.168.7.232:18280`，Chart origin `https://192.168.7.232:18281`。

只替换 Web，镜像 ID `sha256:733e94a513fa4ea770537a07f414f010acd525eab2a062a8fd8d62eb97e6bebb`；由干净产品提交构建，保留正确 Chart origin。15 服务 running，API/PG healthy，其余容器未替换；环境、挂载、端口和网络与更新前一致。截图：[浅色桌面](light-1440.png)、[深色窄屏](dark-390.png)。见 [运行审计](runtime-audit.json) 及 [镜像身份](image.json)。

当前长期运维入口仍为：

```bash
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py status
# start / stop 使用同一入口；start 已固定本次 Web 镜像。
```

本轮 Web 专用回退：

```bash
python3 /home/quant/repos/.mwa-remove-indicator-window-20261022/operate.py rollback
```

回退只操作 Web。若决定长期保留旧 Web，需同步从该私有目录 `previous-durable.json` 恢复长期入口中的 Web 配置项，避免随后 start 再次换回候选；不要覆盖其他服务或使用历史整批 rollback。

数据、供源、认证、TLS、持久卷和受保护浏览器保留；无 seed、迁移、清库。未提交／更新 PR，未等待 CI，未合并 main，未创建正式 tag，未发布生产。
