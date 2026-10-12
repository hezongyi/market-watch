# 深度使用验收证据

目标：既有unraid正式v1.21.2；实际浏览器运行于Ubuntu。见 [完整中文验收文档](../../deep-production-ux-acceptance-20261012.md)。

| 文件 | 用途 |
| --- | --- |
| [summary.json](summary.json) | 时间、版本、7项问题及优先级、3项建议、完成状态 |
| [checks.json](checks.json) | 已执行／未执行路径、保护脚本排除项、待查资源现象 |
| [measurements.json](measurements.json) | 可视区域、弹窗、焦点、身份、类别与实际导出测量 |
| [preservation.json](preservation.json) | 九表指纹、账号／通知、告警字段、工作区清理与退出 |
| [screenshots.json](screenshots.json) | 16张截图尺寸、裁剪与内部ID遮盖说明 |

截图来自实际正式网页，截取后仅裁剪及遮盖部分内部业务ID。裁剪没有移动或重新排版界面。手机越界截图保持原始375／390px宽度，裁切是实际可视结果。保护脚本导致的错误截图没有作为产品缺陷证据。

凭据、浏览器状态、业务对象全文和许可库不进入证据。手机为Chromium模拟，不能代替Android／iOS实机验收。没有创建或销毁正式服务器实例。
