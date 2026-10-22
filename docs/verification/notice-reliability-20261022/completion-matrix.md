# 方案逐项收口核对

方案：`docs/notice-reliability-plan-20261022.md`。API/Web产品提交 `1ba2b33`，Chart产品追加 `9055f2a`（干净构建 `0bd610e`）；30分钟行情观察由用户明确免除，除此之外不缩减四项范围。

| 方案项 | 最终实现及证据 |
|---|---|
| 主机时间、确认成熟度、future-to原窗口有限重试 | timesyncd持久字面时间源，渐进校正无后退跳时；15秒可调成熟余量；`test_notice_reliability`覆盖0/5/7/15秒领先与延迟、游标和原窗口补齐。主机30次同步采样见clock-boundaries，行情17次采样见live-boundaries，两者不同。 |
| 采样、确认、账户健康分离，不相互假恢复 | 独立epoch-fenced JSON状态；门槛仍约束严格消费，展示允许真实新鲜样本。SQLite及新增真实PG契约覆盖双向不掩盖、generation围栏及采样证据；既有live/pricing/recovery/PG套件覆盖认证、限流、晚到分钟和持久恢复。 |
| 安全失败证据、网络与通知抖动 | 白名单reason、operation、HTTP、phase、window、observed/retry；TLS来自真实httpcore trace，不解析异常文本。86项OANDA相关定向回归通过。复用既有请求/退避，按操作及代次维护确认事故；504和超时属于独立网络故障，不假定时钟能消除。 |
| 一致且隔离的验收读写 | readOnlyAcceptance helper使用同一shadow Map支持GET/save/delete/revision，阻断真实workspace/preferences/notice写。真实browser context全新，不接触保护profile。 |
| 409错误分域 | 后端设置/工作区结构化代码；未知409中性兜底，保留兼容中文。相关backend和API真实模块测试。 |
| 偏好持久草稿、CAS和明确选择 | 入队即持久化、每文档writer及精确版本；刷新重开枚举各writer草稿；原生差异对话框、远端变化重读，选择本地/远端后冻结旧widget直至重开。quota/多窗口/持续冲突/新版本保护等Node回归及真实browser。 |
| 设置竞争减少与跨标签成功revision广播 | 相同值不写，尚未开始的同key burst合并；立即保存最新草稿，不跨delete合并。成功revision仅为提示；未触及key读取服务器，已触及key跳过；不更新旧widget观察基线。Node回归验证一写/冲突仍保护/channel关闭。设置RPC共用现有两个管理槽；真实scheduler饥饿回归RED→GREEN，四慢行情不能卡住草稿恢复。 |
| 工作区草稿和对应通知语义 | 保留暂停/复制恢复，writer隔离、版本校验，自有成功不能删他窗或较新草稿。明确采用服务器只结束匹配原观察，不伪造写入恢复。跨workspace历史上下文不足的事故保持原状态。 |
| 首次使用建立屏障及纯列表观察 | 未就绪返回专用COMPOSITE_NOT_ESTABLISHED；列表先纯metadata检查，不调用use/ensure。已有charts/data成功与显式composites/use成功（独立/内嵌数据中心）提示当前订阅重查readiness。 |
| 取消/并发/双窗口/其他4xx和历史ended | 失效listener不唤醒；等待登记早于metadata await，建立提示排队防止丢失。Node真实模块覆盖取消及竞态，API/真实PG验证特定422且不创建组合；保留其他4xx终止、408/429/5xx退避及旧代次ended。 |
| 展示快照、旧资料只读解析和权限 | 新源facts快照，历史读取按不同ID批量解析，权限scope限制，快照优先且不入身份/去重。原198条全部只读核验正确，4次批量名称查询；100条显式类型测试1次名称查询。见all-198-readonly及PG新契约。 |
| 列表/详情/气泡、同名辅助身份和历史搜索 | 统一noticeInstrument；组合显示symbol/type/shortID，raw身份仍在诊断。同名不按symbol合并。SQL分页前EXISTS搜索兼容EURUSD/EUR/USD/大小写及rawID；detail/changes同一resolver。UI真实browser三品种检查与SQLite/真实PG分页/权限/快照契约通过。 |
| 缓存兼容、不制造旧事故重放 | 可选JSON无schema变化；presentationVersion使展示旧缓存重取基线，不新报旧事故。真实PG只读旧reader兼容与notification-center/runtime既有回归。没有重建或改写长期历史投影。 |

独立任务PostgreSQL：PG14.24，既有29项+新增6项全部通过。实例已停止，volume保留。无他人实例/数据库复用。

30分钟行情观察明确跳过；实际17次原采样保留。最终候选真实browser和容器核验另见README。验收不等于main合并或生产发布；本轮不提交PR、不推送、不合并、不打正式tag。
