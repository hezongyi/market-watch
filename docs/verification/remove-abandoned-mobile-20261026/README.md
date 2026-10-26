# 撤出误集成的移动端工作区（2026-10-26）

状态：撤出修正、本地验证及 Ubuntu Docker R1 已完成，交付候选为 `v1.29.0-rc.4`。长期验收实例、main 和生产未更新。Docker 构建源码为 `2f26a71e`；其后交付提交只补充本验收记录。

## 目标与范围

用户明确要求废弃移动端工作区；原实现 `04fd0d01` 的文件副本通过 FXCM 整合提交 `1c8a8ac8` 进入集成分支。用户本次授权定向撤销、验证后合回集成分支并打下一候选。

- 修正分支：`fix/remove-abandoned-mobile-20261026`。
- 工作树：`/home/quant/repos/market-watch-remove-mobile-20261026`。
- 基线：`1293f8a4380e544f67448b88691c4296f6ec2e45`。
- 行为参照：`v1.29.0-rc.2` / `8dd4faf2` 的手机只读单图。
- 风险 F0：撤销兼容前端功能，无后端、schema、持久格式或 worker 修改；最低验证为相关本地检查、自审及一次 Ubuntu Docker 隔离 R1。

撤出四项移动端导航、原图格选择、手机图格保存、自选/旗标编辑、移动端告警定位及暂停/恢复入口，以及它们的构建、样式和测试引用。恢复原手机只读看盘和周期切换；桌面图表和告警编辑继续可用。

没有回滚整条 `1c8a8ac8`，也不回退数据库、工作区内容或用户设置。FXCM 九周期、目录搜索、错误重试、超时、来源切换及历史维护/AKShare 功能保留。此前手机操作产生的真实业务记录不自动删除或改写。

## 实现与自审依据

1. 以原移动端实现 `04fd0d01` 的差异反向应用，26 个文件直接恢复/删除；`advanced-host/bridge.js` 冲突单独处理。
2. 在 bridge 中保留 FXCM 70 秒请求预算、搜索缓存与预热、错误/分页处理、FXCM 目录/量字段，以及不支持周期时切到可用周期的修正。
3. 单独移除整合过程中由软链接转为普通文件的 `advanced-host/mobile-chart-document.js`；其 Web 侧副本和所有引用同步移除。
4. 对原实现涉及的 28 个路径，除 bridge 外的 27 个路径逐一核对到 rc.2：旧文件内容一致，新文件不存在。bridge 相对 rc.2 仅保留后续供源/搜索修复。
5. 后端、迁移、FXCM C++ adapter、锁定依赖与配置逐项未变。
6. 现有完整工作区浏览器回归增加桌面双图→手机竖/横屏只读单图→桌面双图恢复的行为验证；复用真实许可图表库，业务 API 和行情明确为隔离的合成夹具。同步修正该旧测试已过时的取消/创建/保存按钮选择器，并补上搜索预热的只读分页夹具。

本机详细日志和代码比对：`/home/quant/repos/.reports/market-watch/20261026-remove-abandoned-mobile/`。许可库和依赖仅从本机既有目录读取，不提交。

## 已完成验证

- Web TypeScript/Vite/data-center 构建和共享告警 UI 编译通过。
- 21 项 Node 告警改价、桥接及 RPC 测试通过；FXCM 超时、可用周期回退、搜索缓存、品种编码、偏好冲突、自选和旗标检查通过。
- 拖动/Escape、原生价格线、告警面板、编辑回归，以及真实许可图表的价格轴加号菜单测试通过。
- 完整工作区测试 7 组场景通过：原生另存、工作区切换、旧响应隔离、版本冲突、Yahoo 故障/恢复及周期回退，以及新增手机只读往返专项；页面异常和未预期请求均为 0。
- 新增专项以真实图表库加载桌面双图，分别验证 390×844 与 915×412 手机单图、H1/D1 切换、桌面草稿保持、布局/偏好/告警写请求为零、保存文档及 revision 不变，桌面重开仍为双图。
- 代码范围、27 个路径与 rc.2 比对、bridge 保留差异、JS 语法及 git diff --check 通过；结果汇总见 [checks.json](checks.json)。

上述本地浏览器测试使用源码、真实许可图表库及合成 API/行情；下述 Docker R1 另行使用实际构建的 Web/API/Chart 与独立 PostgreSQL，业务响应未被浏览器替换。远程 CI、真实 FXCM 上游认证及通知投影/投递链不在本次验收结果中。

## Ubuntu Docker R1

- 实际主机：Ubuntu `quant-server`，本机 Docker；task/project 为 `mw-remove-mobile-20261026`。
- 实际地址：Web `https://localhost:18865`，Chart `https://localhost:18866`。均只绑定 `127.0.0.1`，使用任务自签证书。
- 五服务：PG 14.24、API、Web、Chart、Nginx 网关；无 worker。独立 internal 网络、edge 网络、`mw-remove-mobile-20261026_postgres-data` volume、`preview` 数据库和私有凭据，归属与镜像核验通过。
- 镜像使用工作树构建工具、专用 BuildKit 顺序构建，源码 `2f26a71e`，dirty=false；三组件完整 image ID 见 [checks.json](checks.json)。共享工具和默认阈值未修改。
- 首次受 23 GiB 磁盘门槛阻塞；用户随后明确批准“不受阀门限制，直接进行 docker r1 验收”。实际启动时可用磁盘 10.56 GiB、内存 7.48 GiB、5 分钟负载约 11.74。本任务私有启动脚本只对精确 task/project 的磁盘和负载预算门槛执行本次例外；保留内存、端口、镜像、网络/volume 归属和健康检查。
- 数据为默认 `d1-v1-ef528135a493` 合成种子。其 Dukascopy EURUSD 不适用当前 managed 前端接口，因此改选已存在的 Binance `D1_BTCUSDT` 合成品种，只在本任务库启用它以完成告警 smoke，并把验收自选设为该合成品种。无真实供源凭据、不运行采集/通知 worker，不宣称上游数据或告警实际触发验证通过。

实际浏览器 R1 六组通过：登录及种子工作区读取；桌面双图保存到实际数据库并刷新恢复；原生告警创建、编辑和版本递增；390×844 与 915×412 手机只读单图及 M1/H1 切换；手机期间工作区文档/revision、偏好、告警、草稿不变；返回桌面仍恢复双图。页面异常 0、手机写入 0、未预期失败响应 0。截图确认手机只读提示、单图显示和移除后的入口状态。

五服务 R1 不含通知投影 worker；通知观测/投影确认出现两条 404“尚待投影”，`notifications/runtime.ts` 已明确按 404 延后重试。此行为单独留证，不冒称全请求无 4xx 或通知链验收通过。首轮脚本旧登录按钮、通用种子不适用及上次工作区选择问题均留档，最终脚本修正后实际重跑通过。

实例保持运行，保留所有任务数据。私有凭据不写入文档或 Git；完整日志、截图、脚本和脱敏运行清单位于 `/home/quant/repos/.reports/market-watch/20261026-remove-abandoned-mobile/docker-r1/`。

从本修正工作树执行：

```bash
# 本次用户授权的资源门槛例外，严格限定本任务；保留数据重启。
python3 /home/quant/repos/.reports/market-watch/20261026-remove-abandoned-mobile/docker-r1/preview-resource-exception.py preview up --task mw-remove-mobile-20261026 --project mw-remove-mobile-20261026
# 只读状态。
python3 deploy/ubuntu/mw_docker.py preview status --task mw-remove-mobile-20261026 --project mw-remove-mobile-20261026
# 只停止本任务，保留数据库和 volume。
python3 deploy/ubuntu/mw_docker.py preview stop --task mw-remove-mobile-20261026 --project mw-remove-mobile-20261026
# 重跑实际浏览器 R1；读取私有凭据，只写本任务合成数据。
node /home/quant/repos/.reports/market-watch/20261026-remove-abandoned-mobile/docker-r1/acceptance.cjs
```

交付分支为 `market-watch-integration-20261024`，下一候选 `v1.29.0-rc.4`；现有 rc.3 不移动。远端 tag 的实际 peeled commit 留在本机 `docker-r1/delivery.json`。不合并 main，不更新长期验收实例，不部署生产，不清理其他任务资源。
