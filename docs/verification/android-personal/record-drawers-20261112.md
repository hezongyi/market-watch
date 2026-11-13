# 后台通知与告警记录抽屉一致性检查

分支 `feat/android-personal-v205`，F0：兼容的前端弹层和控件迁移，无 API、schema 或持久格式改动。使用项目手机端 UI skill 与 shadcn；按当前任务上下文，范围为“更多”中的后台通知、告警记录及其记录详情。未跑 CI、未更新 PR。

## 原因与修复

更新前在真实412px视口测量：后台通知已是shadcn Drawer，宽412px、标题18px、圆角24px；告警记录仍是原生dialog，宽378px、标题20px、圆角23px，遮罩与退场也不同。

- 记录列表和嵌套详情接入共享 MobileOverlaysProvider / Drawer，使用与后台通知相同的宽度、标题、边距、圆角、遮罩、拖动和返回机制。
- 触发/异常恢复/系统改用shadcn Tabs，列表、分页、重试及处理动作改用Button，保留所有读取和处理业务。
- 记录与设置详情均按内容自适应高度，长列表达到共享最大高度后内部滚动；避免空态强制铺满屏幕留下大块空白。统一尺寸规则，不强制不同内容同高。
- RecordsSheet改为受控open并保持挂载，退场结束后清理临时页签/详情状态；请求仅在打开时执行，提交中阻止误关。嵌套返回只关闭详情。
- 第一轮截图发现150%字号下“异常 / 恢复”换行，第二轮缩去视觉空格为“异常/恢复”，保留原可访问名称，窄屏大字号单行可读。

## 控件迁移范围核对

| 范围 | 实现与结果 |
| --- | --- |
| 更多页操作与四个设置详情（含后台通知） | Button + Drawer，切服务器为AlertDialog，已迁移 |
| 告警记录/事件记录及嵌套详情 | 本轮迁移Drawer + Tabs + Button；从更多、底部告警或自选入口进入均复用 |
| 自选控件 | 前轮已迁移，保持现有实现 |
| 底部告警页：规则创建/编辑、筛选、规则详情、归档/冲突确认 | 仍有原生MobileSheet、input/select/button及confirm，尚未全迁移 |
| 独立数据页与专业图表 | 保留既有实现；专业图表还包含第三方原生控件，不能宣称全App已换 |

核对结合源码的组件导入、Base UI组合、实际打开状态及运行时可见控件检查，不把data-slot作为唯一完成依据。此次“更多→后台通知/告警记录”范围内已无遗留原生交互控件，但整个手机端尚未全部换成shadcn。

## 验证

本地 `npm run build`、`git diff --check` 通过：

```sh
cd web
MOBILE_MORE_OUTPUT=/tmp/mw-records-final-auto node tests/mobile-more.browser.cjs
node tests/mobile-alerts.browser.cjs
node tests/mobile-app.browser.cjs
```

更多脚本新增375/412px、深浅主题、14/21px字号的记录截图与实际几何对比：记录与后台通知宽度、标题字号、圆角、内容水平边距相同；整页/弹层无水平溢出。覆盖记录Tabs状态和ARIA关联、长标题列表、嵌套详情返回、关闭后交接及可见控件审计。既有告警业务测试覆盖显式处理、版本冲突和输入保留等。页面错误均为零。

夹具用于完整状态及写操作验证，Ubuntu真实环境只读登录、切本地主题及打开记录，不确认真实事件、不修改规则或偏好。Android真机手势和实体返回仍待体验。

截图与记录：`a07-feedback/record-drawers/`。前后对比针对告警记录抽屉；后台通知已为新控件，是本轮尺寸参照。

## Ubuntu验收实例

实际主机 `quant-server`，既有隔离project `mw-android-personal-v205`。预检可用内存约7.3GiB、磁盘约13GiB，只更新web，未动Unraid或其他实例。api/postgres/tls正常；HTTPS CA验证 `/readyz` 为ready。

地址 <https://192.168.7.232:18445/m/>，手机“更多 → 检查更新”，无需新APK。Shell `2bed9c4c6a07873e`。

用 `mw-docker build` 构建候选 `market-watch-web:android-personal-v205-record-drawers-auto`，task/project均为 `mw-android-personal-v205`、用途acceptance。固定镜像 `sha256:7d26388eb8fc551814c3eb89e75f4828c5ecb8c10166436a4a0e1c0263217832`。旧镜像 `sha256:d55ac889ac787e409f465263c8b902c2cf1a584dda8c830f9f78637748a97420` 和0600私有配置备份 `before-record-drawers-run.json` 保留。

启动/更新：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同参数将最后一行替换为 `stop web`。回退（未执行）：第一个配置替换为同目录 `before-record-drawers-run.json` 后执行同样up命令，不改数据库。
