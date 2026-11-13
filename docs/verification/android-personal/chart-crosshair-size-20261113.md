# 手机 Header 十字线按钮尺寸

用户反馈去掉文字后尺寸仍未调整。浏览器实际测量原按钮 44×38px，SVG 18×18px；相邻原生 K 线类型按钮为 38×38px。此次只修改手机 Header 样式：按钮固定 38px 宽，沿用原生 38px 高；SVG 改为 24×24px，文字容器撑满并居中、清零行高和按钮左右 padding。顺序及十字线功能不变，网页端不变。

P0 局部样式修改。构建通过；实际许可 widget 对比 375/412px 深浅主题，按钮均为 38×38px；150% 外层字号检查、开关与高亮检查通过，无页面错误。此次用临时浏览器截图脚本检查，未为局部 CSS 增加产品测试逻辑。截图及前后尺寸见 [chart-crosshair-size](chart-crosshair-size/)。另通过 git diff --check，按用户要求不跑 CI、不更新 PR。

Ubuntu quant-server 隔离项目 mw-android-personal-v205，只替换 web。部署前可用内存约 9.3GiB、磁盘约 15GiB，无新增服务/数据库；mw-docker build 构建：

- 地址：<https://192.168.7.232:18445/m/>。
- Shell：`e276e7395ea898ba`。
- 镜像：`market-watch-web:android-personal-v205-crosshair-size-20261113`。
- image ID：`sha256:bd7265075291fb2c91655c4be0e5bdbd6ec4622c5139675168b766ee451c7780`。
- web healthy；证书校验 readyz、Shell 及实际图表脚本确认新尺寸已服务。
- 私有 before-crosshair-size-run.json 保留上一版配置，权限 0600。

启动/停止命令沿用 [图表部署记录](chart-continuity-20261113.md#部署与手机更新)，run.json 已固定当前候选。手机“更多 → 检查更新 → 更新页面”更新，无需重装；真机触感仍由用户确认。未操作 Unraid。
