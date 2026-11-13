# 自选价格层级、昨收参考与开盘缩放

用户认可右侧改为涨跌幅主、价格辅，并指出缺少昨收线、EURUSD 开盘纵向拉伸夸大波动。本轮实现上述范围。分类 F0：前端显示行为与报价元数据兼容扩展，无 schema、持久格式或后台采集规则变更。PR、提交、CI 按用户要求暂缓。

## 实现与语义

- 右侧上行涨跌幅约 15px / 600，下行价格约 12.5px / 常规字重、中性色；常规右列 84px，375 窄屏约 81px。修正原窄屏样式把字号重新放大的覆盖规则。stale 涨跌幅继续灰色显示。
- Quote 增加 `display_precision`，复用各品种元数据的显示精度，缺少显示精度时使用原精度。覆盖 Yahoo、其他平台、自建/历史/组合报价；原始 lp、采样缓存与图表数值不做四舍五入。前端只格式化展示、去尾零，不用 K/M 缩写或价格省略号；完整值仍保存在标题与行情数据里。
- 昨收线使用既有 `prev_close_price`，与同源报价的 `chp` 共用基准，不由当前第一笔或涨跌幅反推。该值含义为供应商/行情自身的前一收盘期，不能声称所有源都采用纽约 17:00。横轴仍沿用原 Sparkline 日界。Quote 读取时间必须落在当前 Sparkline 窗口，组合修订不匹配时仍不绘制旧图。没有有效昨收时不画基准线。
- 纵轴以昨收居中，上下至少各 0.5%；超出后以最大偏离的 1.1 倍扩展，保留边距。没有昨收时用首个观察值作布局中心，但不冒充昨收线。平价序列居中。真实开盘跳空、负价格、缺口、未来时间留白、峰谷保留。
- 上一轮面积色和渐变、原折线配色与 72% 不透明度保留。横向昨收虚线与竖向时段线使用不同样式。

最小幅度是视觉缩放下限，不是波动上限；超过下限的行会自动扩大范围，不应据线条高度直接比较不同品种百分比。

## 验证

- 18 项后端定向测试通过：Yahoo 显示精度元数据、Quote 透传与原始 lp 保留、平台昨收/涨跌幅与精度、既有自建报价缺失处理。
- Sparkline 与格式化测试通过：1.10000 → 1.10010 的开盘变化占不到 0.4 SVG 单位；真实跳空可见且不裁切；缺失/无效昨收不生成参考线；极值、断档、时序、简化误差保留；外汇/小价格精度正确。
- TypeScript/Vite/mobile shell 构建通过；自选行为回归通过。
- A07 8 组深浅/窄屏/大字号/横屏、弹层/离线/更新入口通过，更新断言检查新价格层级与有/无昨收线。
- Ubuntu 实际隔离行情，375/412 × 深浅四组通过：右侧百分比主次、EURUSD 小数位、至少五个有效昨收基准、无价格与图表碰撞、渐变/折线透明度正确、无 pageerror。证据见 [price-baseline/proof.json](a07-feedback/price-baseline/proof.json)。实际 EURUSD 元数据给出的显示精度为 4，本轮遵从该值，未把数据精度 8 当作显示要求。
- HTTPS 使用任务 CA 验证 readyz 200 和新网页 build。首次切换 API 后代理缓存旧上游地址导致短暂 502，`nginx -t` 成功后重载任务 TLS 代理，再验证通过。
- 原生真机视觉验收待用户完成；此次没有 APK 改动。

## 当前交付与运行

Ubuntu `quant-server` / `192.168.7.232` 本机 Docker project `mw-android-personal-v205`。资源检查磁盘可用 31 GiB、内存约 5.5 GiB。复用原五服务、独立数据库及端口；仅更新 web、api、data-worker（实时报价也需要携带显示精度）。无数据重置、迁移或 Unraid 修改。

- 地址：<https://192.168.7.232:18445/m/>。
- 网页 build：`9f29b1d7d00e566f`。APK 保持 0.1.3，通过更多 → 检查更新刷新网页。
- web：`sha256:17e651baa58ad7e5180d59a60449c63b34f53e65923cceed196cbecfa711bed6`。
- api/data-worker：`sha256:7886c20c41de3899f988768a2ecc38ab869294185184aa15a138f2c9369981ef`。
- 旧 web：`sha256:bd96ee8e20cc3ae93e253f8699426d2c27beb5104adb4a80d4db2691ee913dc1`。
- 旧 api/data-worker：`sha256:4ddcbbd552f700d7785692afdcce1b2a696a3f10600e023c432ee420dac97a35`。

镜像通过 `mw-docker build` 显式标记 task/project/acceptance 并检查标签；仅更新私有配置中对应服务镜像。切换前私有配置备份为同目录 `before-price-layout-run.json` 和 `before-price-layout-live-data.override.json`，不提交私有配置。

启动/停止：

```bash
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --wait

# 停止使用同一前缀与两个文件，将末行换为 stop。
```

本次仅执行 `up -d --no-build --pull never --no-deps --wait api data-worker web`。服务更换地址后检查并重载任务 TLS 代理：`docker exec mw-android-personal-v205-tls-1 nginx -t`，成功后 `docker exec mw-android-personal-v205-tls-1 nginx -s reload`。
