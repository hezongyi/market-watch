# 自选控件布局评审与补迁移

分支 `feat/android-personal-v205`。使用 huashu-design 评审和两轮截图打磨，React实现沿用项目手机端 skill 与 shadcn base-nova。F0：兼容的前端交互调整，无 API、schema 或持久格式变更。按用户要求未跑 CI、未更新 PR。

## 结果

- 管理页使用 Tabs 区分品种与分组；管理入口默认品种，分组管理入口默认分组。分组内排序仍为 Collapsible，原保存、放弃、立即排序和冲突处理语义保留。
- 操作行64px，分组选择56px，主按钮/输入容器48px，图标触摸区44px；大字号自然增高。新建组使用内嵌添加按钮，组卡的上移/下移/删除与展开区对齐。
- 自选入口、重试、行情行点击、通知关闭及搜索结果操作使用 Button；搜索与新建组用 InputGroup；来源筛选用 ToggleGroup；详情选组用 Select；其余弹层、确认、分组选择复用 Drawer / AlertDialog / RadioGroup。
- 检查 WatchPage/WatchOverlays 无遗留原生交互实现；运行时审计实际自选可见 button/input/select/textarea 的组件标记。共享 DataPage 在自选上下文使用新控件，普通数据页保持既有外观；不宣称整个手机端所有页面已迁移。
- 修复选组关闭后通知挂入隐藏菜单的问题，返回只关闭当前选组菜单。来源“全部”使用非空显示值再映射回空来源，首次及切回均有明确选中态。

[评审报告（内嵌真实前后截图）](../../prototypes/android-watch-controls-review-20261112/review.html) · [截图对照](a07-feedback/watch-controls-layout/before-after.png) · [打磨记录](../../prototypes/android-watch-controls-review-20261112/polish-log.md)

## 验证

`npm run build`、`git diff --check` 通过。以下本地脚本通过：

```sh
cd web
node tests/mobile-watch.browser.cjs
MOBILE_VISUAL_OUTPUT=/tmp/mw-controls-layout-a07-final node tests/mobile-watch-a07.browser.cjs
node tests/mobile-alerts.browser.cjs
node tests/mobile-app.browser.cjs
node tests/mobile-sparklines.cjs
node tests/mobile-transport.cjs
```

自选覆盖来源单选、详情选组/默认选项/返回/成功通知、控件覆盖审计，以及未保存保护、冲突保留、排序动画、删除取消、保存中阻止关闭、跟手/回弹/关闭、减少动态效果。视觉覆盖375/412px、深浅主题与150%字号，新增页签与活动面板满宽断言。浏览器移动应用回归的离线退出检查原来在本机异步清理未完成时重载，修为等待登录按钮恢复可用后重载；未修改应用退出逻辑。

huashu-design 的 Python Playwright 不可用，以项目 Node Playwright执行同一 COLLECT_JS，再由原 Python palette/layout/judge 计算检查与账本；不是跳过检查。报告在375/1200px无横向溢出、无缺图，检查记录见同目录证据。

[上线只读记录](a07-feedback/watch-controls-layout/live-after/proof.json) 的页面错误与业务写请求均为零。深浅主题、375/412四组真实页面的主行高度、左右列宽及位置、sparkline宽高与更新前相等；行高72px、图高50px，仍为直线渲染。价格变化来自实际行情，本轮未改行情业务。

截图是构建页面与明确API夹具，实盘验收仅登录、读取行情和开关控件，不写真实自选。Android系统软键盘、连续手势和实体返回键仍待真机体验。

## Ubuntu预览

实际主机 `quant-server`，既有隔离project `mw-android-personal-v205`；只更新web，不涉及Unraid。预检可用内存约7.4GiB、磁盘约15GiB。web/api/postgres/tls正常，HTTPS CA校验 `/readyz` 为ready。

地址：<https://192.168.7.232:18445/m/>。手机“更多 → 检查更新”，无需重装APK。Shell `70f4de9eb3ab4eca`。

使用 `mw-docker build` 构建候选 `market-watch-web:android-personal-v205-watch-controls-layout`，固定镜像 `sha256:93044660c4904e5778411e130c6b6770c39d700d031f1b3aed00ec962069fc49`。旧镜像 `sha256:a4f7c32206120a68174e4fd5e0fae613bd0502c778d70833963f89aa34559a01` 保留，配置0600备份 `before-watch-controls-layout-run.json`。

启动/更新：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：相同参数将最后一行改成 `stop web`。配置回退（未执行）：第一个配置换为同目录 `before-watch-controls-layout-run.json`，再执行同样up命令；不动数据库。
