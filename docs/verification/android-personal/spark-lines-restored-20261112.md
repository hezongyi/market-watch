# 自选走势恢复上一版折线

用户要求仅回退“按图宽减少密集折点，并加入不过冲的圆滑处理”，其他优化保留。P0 局部绘图逻辑变更，无 API、schema 或持久格式变化；未更新 PR、未跑 CI。

恢复固定 0.7 SVG 单位的原简化算法和 M/L 直线路径，删除新增的密度预算及单调三次插值。继续保留 M5 显示采样、50px 图高/72px 行高、有效实时报价末点、观察轮询与历史准备解耦、导航保留行情连接及前后台恢复逻辑。

同一份实际七品种历史数据，在 150/200/229px 三种图宽共 21 组比较中，恢复后 line、area、end 与旧版在相同 M5 样本上生成的路径完全一致。前端生产构建、`mobile-sparklines.cjs`、`mobile-transport.cjs`、`mobile-watch.browser.cjs`、`mobile-watch-a07.browser.cjs` 均通过。浏览器回归覆盖收到报价后两秒内曲线改变且不新增历史请求、导航与后台连接生命周期、375/412 与大字号布局等。

运行主机 Ubuntu 本机 `quant-server`，复用隔离项目 `mw-android-personal-v205`，仅更新 web。预检可用内存约 7.8GiB、磁盘约 18GiB。验收地址 <https://192.168.7.232:18445/m/>，手机“更多 → 检查更新”。镜像由 `mw-docker build` 构建：`market-watch-web:android-personal-v205-spark-lines-restored`，固定 ID `sha256:41b01dfc05a5b0025022fec27fc698ddfeec64357d86a90dfdddc21375076654`，shell `e485f62d06d1eb36`。HTTPS CA 校验 `/readyz` 返回 ready。

配置目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`；旧配置 `before-spark-lines-restored-run.json` 及旧镜像保留，配置文件权限 0600。

启动/更新：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同参数将最后一行改为 `stop web`。配置回退（未执行）：第一个配置改为同目录 `before-spark-lines-restored-run.json`，再执行同一 up 命令。

实盘浏览器验证 shell 为上述版本，所有 SVG 均无 C 曲线指令。EURUSD 新报价由 1.10924 变为 1.10889 时，曲线在同一 DOM 提交同步改变；该次变化早于下一次历史观察请求，来源 M1 时间戳为 `1794492240000`，历史尾端为 `1794492180000`。375/412 × 深浅主题四组截图已人工查看，无横向溢出、页面错误，行高/图高仍为 72/50px。证据见 [实盘记录](a07-feedback/spark-lines-restored/live-proof.json) 和 [浅色截图](a07-feedback/spark-lines-restored/light-412.png)。手机 WebView 观感待用户验收。
