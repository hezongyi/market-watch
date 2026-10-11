# v1.20.1 既有布局告警初始化回归

生产 v1.20.0 登录成功，已保存五图布局触发首个 `activeChartChanged` 订阅前的空取消订阅，抛出 TypeError 并阻断 `alertUIAttach`。图表、行情与数据中心可加载。旧发布清单保持原样，失败状态另存 v1.20.0 独立验收记录。

真实许可库回归先复现同一错误，再验证首次绑定、重复绑定只有一次回调、保存两图布局重建与重复清理，四项通过。独立 Spec 另外检查同一 widget 的 load 后活动图回调仍只有一次。Standards 的历史清单修改发现已恢复；两轴无剩余阻断。

Ubuntu 独立 Docker project/task `mw-alert-init-v1201-20261011` 使用专用 BuildKit。API/chart clean `c23537d`，web clean `e6d3393`；两提交间仅恢复旧生产清单文档，应用源码完全一致。生成 BTCUSDT 五图 `2-3` 布局并持久保存后重新加载，六组实际 API/原生 UI/SSE 验收通过，无 route mock、无页面异常、HTTP 错误或图表域凭据。测试未保存告警或投递通知。

首次临时测试套用生产只读拦截，阻止空数据库初始化，不能视为产品失败；随后补启历史 worker 并在本项目初始化只含可用 BTCUSDT 的自选表。原始生产工作区私密读取未提交，也未复用生产数据库。最终结果与镜像见本目录 JSON；不是完整后端或历史全业务重跑。

运行入口 `LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu node web/tests/chart-active-event.browser.cjs`；完整临时 Docker runner、私密配置及启动记录在 `/tmp/mw-alert-init-v1201-20261011/`。生产正式验收见 [v1.20.1 交付](../../saved-layout-alert-v1.20.1-production-delivery.md) 与本目录 production/。
