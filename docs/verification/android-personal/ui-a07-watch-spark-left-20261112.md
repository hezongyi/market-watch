# Sparkline 向左扩展

分支 `feat/android-personal-v205`，基线 `848b8214`。P0 局部样式调整：左侧固定列从 5.7rem 收窄至 5.1rem，默认字号下从 79.8px 改为 71.4px，释放 8.4px 给中间曲线。右侧价格列 4.8rem、6px 列间距、代码自适应字号、中文和供应商字号及行距保持。375px 屏幕曲线从约 184.0px 增至 192.4px；412px 从 221.0px 增至 229.4px。72px 行高、42px 图高以及上一交易日蓝色/开盘线保持。

前端构建及既有浏览器回归通过（8 组布局、窄屏/大字号控件、长代码/价格边界等），shell `de3366546a94bc2a`。验收关注左右固定列边界、长代码自动适配、现有供应商名称不截断、三列无重叠及深浅主题截图。

Ubuntu 主机 `quant-server`，实例 <https://192.168.7.232:18445/m/>，project `mw-android-personal-v205`。预检约 9.4GiB 可用内存、22GiB 剩余磁盘。仅更新本项目 web，复用端口和数据库，不操作 Unraid、不更新 PR、不跑 CI。使用 `mw-docker build` 明确 task/project `mw-android-personal-v205`、purpose `acceptance` 构建，镜像 `market-watch-web:android-personal-v205-spark-left` 固定为 `sha256:769814979746a4bbe0851a5c3d1788bfb97b848d74919e161714bab490aa932f`。

私有目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/`，修改前备份 `before-watch-spark-left-run.json`（0600），旧镜像保留。启动/更新已执行：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（留档，未执行）：同参数后使用 `stop web`。回退（留档，未执行）：第一个配置文件替换为同目录 `before-watch-spark-left-run.json`，运行同样 up 命令。APK 通过“更多 → 检查更新”取得新资源；最终手机观感待用户验收。

实盘 375/412 × 深浅四组截图已查看，实测左列 71.39px、右列 67.19px，中间图宽 192.42px/229.42px，各行等宽；现有代码、中文说明及供应商未相互遮挡，供应商名称均无截断，页面无错误。CA 校验 `/readyz` 正常，web healthy。[前后对比](a07-feedback/watch-spark-left/comparison.jpg)、[实盘测量](a07-feedback/watch-spark-left/proof.json)、[布局回归](a07-feedback/watch-spark-left/fixture-proof.json)。前后截图行情时间不同，价格与曲线形状不作为样式比较依据。
