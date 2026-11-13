# 实现依据

本机已安装许可包 TradingView v31.1.0，内部版本 6b804c486857f27920cf761aa7eb6e29d9bb6362。依据为随包 charting_library.d.ts 及实际 widget，不声称已经线上文档核验。

- header_widget：顶部原生 Header。
- header_resolutions：顶部 K 线周期选择；items_favoriting 允许加星，favorites.intervals 指定初始值。
- timeframes_toolbar：底部时间范围栏，本次明确保持隐藏。
- left_toolbar：原生绘图／光标工具栏；公开 drawingToolbarAction 可展开收起。
- 原生移动菜单按库自身响应式表现为底部面板；周期收藏快捷按钮仍位于顶部 Header。
- 源包 TV_v31.1.0_0430.zip 和本机安装均缺少 hammerjs.faf756299593572313c8.js（chunk 85652 / module 682937），已有底层 chunk 72141 / module 172141。构建桥只连接导出，不实现或替换手势算法。
