# 当前界面增量自审

2026-10-19，产品检查点 b949560；比较 f2184e8（旧 UI 验收）至当前。分类F0/R1，本人自审。未把旧独立Standards/Spec报告冒称当前界面审查。

| 用户合同 | 当前实现 | 验证 |
| --- | --- | --- |
| 系统中心不含交易 | runtime.history 强制 audience=system，Panel 额外按 source_kind 过滤；服务端 list_events 分流和 distinct system_unread | 26个系统中心后端专项、浏览器交易标题搜索为空、系统角标只用system_unread的Runtime断言 |
| 交易日志为唯一管理位置 | nativeAlertUI.event→ChartAlertsPanel.focusEvent；AlertEventTrace 在原日志展开；旧 notice/signal 路由转向相同signal | 真实服务合成观测触发、卡片点击与两类旧链接选中相同 data-signal-id；URL保留signal |
| 不改变图表布局 | nativeAlertShell page=null，仅加载控件；系统中心portal到native doc；无新widgetbar page | 相同画布矩形、原生pages、850/390截图 |
| 唯一即时提示及操作隔离 | 单Runtime queue/bubble；原生/父页面表面按notificationReady互斥；卡片不自动focus，只有卡内Escape处理 | 两类卡同坐标；稳定控件焦点、角标更新语义焦点、外部Escape、真实drag/wheel；阻断shell后恢复互斥 |
| 控件尽量原生 | InputControl/Select/Checkbox/Button/PopupMenu/PopupMenuItem复用；私有控件与toolbar rect访问留在固定v31适配器 | 菜单点击/End/Enter、Select点击、原生checkbox设置、版本保护；未修改vendor |
| 重复与恢复 | 服务端按incident代表行返回，详情原始发生分页；恢复更新incident | 重复2次单行、恢复状态、后端稳定分页与原始页；info和重复不追加即时卡 |
| 有界全部已读 | 服务端每事务最多100条，限定epoch/through/incident；Runtime固定水位续批 | 100+5边界、新消息不读、epoch拒绝、事故隔离，原始未读分页只返回剩余5条 |
| 阅读不停止手机 | 系统read只写viewed，交易trace只observe viewed；手机停止为原日志独立显式操作 | 后端phone ack/outbox保持，UI读全部前后交易viewed/handled/channels保持 |
| 系统偏好不抑制交易 | 按subject/profile IDB保存，同源BroadcastChannel同步；仅过滤system queue，不回弹历史 | 刷新/双tab、关闭期间交易卡成功、Runtime队列断言 |
| 不补弹过时消息 | 接收和出队均校验服务端接受时间30s，队列最多20 | Runtime模拟前卡长悬停后expired跳过且不获得claim |
| 中文与字面搜索 | JSON解码title/message/code与instrument/workspace查询，contains autoescape保留 | SQLite中文/百分号/下划线断言；真实PG API和UI中文恢复记录搜索 |
| 旧出口退役 | main不再按signals差异发声；普通被动native notice改为上报info；草稿恢复与表单弹窗保留 | 源码核查 activeNotices只recover确认；界面无.mw-chart-notice，legacy history排除专业交易记录 |

未见当前范围内仍未解决的具体P1/P2。该结论不代替CI，生产发布、合并、真实手机送达、物理听觉与全浏览器无障碍均未签收。当前即时卡外壳是自定义非模态容器，用户已在对话中获知其与showNoticeDialog的差别；没有因比较截图擅自切换交互。
