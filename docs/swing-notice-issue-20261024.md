# Swing 价格展示与即时通知调整

本地 Issue 草案，未发送外部服务。

基线 v1.28.0 / 59ed3a3f3fc727da76d13149934d999ebee04218。
分类 F0 / Ubuntu R1：仅兼容展示与通知布局，不改算法、schema、持久格式或确认协议。
目标：Swing 继承图表实际 formatter；每实例 high/low 各一组标签，保留四绘图和桥接；即时通知右下角和上下进退动效。
最小检查：任务书列出的 build/定向回归、原生浏览器矩阵、本地 CI 同等检查、自审、mw-acceptance 真实实例验收。
用户覆盖任务书：使用现有 mw-acceptance 而非新空 preview；不提交 PR，不推送或合并，不生产发布。
