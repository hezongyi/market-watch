# Dukascopy 自建历史恢复与手机错误语义

2026-11-20；代码基线2bb0adea，手机修复53555e32。F0：供应商专用代理配置恢复及手机只读状态解释，无schema变更，无永久数据删除。Ubuntu量化开发实例mw-dev直接验收；没有部署Market Watch生产版本或正式tag。

## 原因及处理

全量盘点22个维护品种（含1个归档），原有135个配置周期可读取。10个Dukascopy品种的新一轮维护反复retrying/unavailable，现有9周期历史未丢失。后台日志与同容器新客户端、相同XAUUSD身份/窗口/history lane均复现TLS EOF，安全HTTPX trace为proxy.start_tls.failed → ConnectError → SSLEOFError/UNEXPECTED_EOF_WHILE_READING，无HTTP响应。重建连接池不足以解释或解决本次问题。

选路停在仅有两个香港节点的故障转移组，两个候选均无健康记录。按本轮用户授权，增加Dukascopy独立故障转移组，最终仅使用三个候选（日本、美国、新加坡），保留原香港组供回退；其他Selector和非Dukascopy配置逐项比较保持不变。完整配置只在私有路径留档，经Mihomo校验后保存并重载，store-selected保持有效。

健康检查指向Dukascopy实际历史接口，180秒间隔、8秒超时。HEAD可能返回429，因此expected-status明确接受200/429作为TLS/HTTP可达证据，避免将限流误判成断线；不把429当成历史请求成功。实际取数仍由现有worker按响应进行限流退避，没有新增即时重试或关闭证书校验。初稿候选过多且仅接受200，本轮发现上述误判后收窄为三个候选并修正；最终三个候选的专用URL健康记录均为true。数据读取另由原任务的accepted/data审计证明。

手机自建详情原先直接输出task_error，用户看到unavailable但不知旧历史仍可用。现在将已知历史错误译成明确描述；仅retrying表述系统自动重试，保留按真实可用周期判断的“已有历史仍可查看／尚无可用历史”。任务页复用同一错误解释；未知错误保留原文，避免掩盖配置问题。维护配置、实时开启意图和后端数据就绪判定不变。

## 验证与边界

- 相同XAUUSD窗口恢复为4,140根M1、4.99秒；最终日本出口下BTCUSD对照4,320根、2.19秒。这是独立供源对照，不能代替后台验收。
- 通过现有公开任务control/retry入口推进原任务，未另建导入器或改数据库游标。10个原版本均取得accepted/data、cursor=end、status=published且error清除；其中BTCUSD九周期完成并清除活动任务。其他9个版本仍在物化各周期，旧发布产物继续供读取。这里的published是父M1快照，不代表全部周期完成；验收未把后台派生说成全量完成。
- 22个品种135个周期，在修复前及部署后分别通过真实认证图表接口读取非空K线且pending=[]；部署后按管理列表每周期available_version_id读取，验证物化期间旧版本仍能承接查看。
- mobile-managed-facts语义检查通过：有/无历史、重试/终止失败、恢复后消失、未知错误保留。实际生产构建+浏览器HTTP夹具通过，覆盖超时及unavailable、长期设置稳定、日志/离线、375/412px、深浅主题及150%字号，共21张截图。
- 已部署页面只读验收：真实XAUUSD详情、图表入口可用、无英文unavailable、无横向溢出，375浅色及412深色150%字号通过。无业务写入或页面错误；浏览器验证不冒充Android真机验证。
- 完整Web构建、git diff --check通过。APK下载挂载保持，更新清单及APK HEAD仍200；无需更换APK。

## 部署与回退

实际运行主机Ubuntu quant-server，入口 https://quant.kookvv.com:8443 。只替换web，镜像sha256:32781c2eaab3ca9beda9c85363f460fd3d24beaf73c3cac7b72b62d2966bc1ed，对应53555e32。API/data-worker仍为fa36ff5f，market-runtime仍为2558e6d5；所有非web容器ID保持，数据、凭据、通知和下载挂载保留。

持久入口为`~/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json`；启动`docker compose -p mw-dev -f <该文件> up -d --no-deps --no-build web`，停止仅同入口`stop web`。回退仅将services.web.image恢复为sha256:76bd14db7cdc54cf0ae2fcd15482cee875e4f64a3cc6ff5ba21f6fb5f325f53f后定向up，不整体恢复旧配置或重启worker。

代理原配置备份位于Unraid现有Mihomo的`backups/config.pre-dukas-20261120.yaml`；恢复时先核对并仅恢复Dukascopy相关组及其原选择，保留后续其他代理修改。本次只维护现有网络服务，没有在Unraid创建开发实例。

原任务、读审计、代理专项健康、前后配置、真实135周期接口、部署摘要、截图及回退材料保留在私有`~/.local/share/market-watch-dev/evidence/dataset-health-20261120/`。完整环境、凭据和代理配置不提交。该次恢复不保证上游或节点永不故障；持续连接失败仍按已有退避等待。
