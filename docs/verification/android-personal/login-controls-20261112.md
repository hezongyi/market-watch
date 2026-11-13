# 手机登录页迁移与打磨

分支 `feat/android-personal-v205`。F0：登录表单和反馈迁移，保留认证 API、存储格式、会话取消及原生壳协议。使用项目 `market-watch-mobile-ui`、shadcn 与 skill-creator；未跑 CI、未更新 PR，未操作 Unraid 或18443。

## 完成范围

- 独立 LoginPage：白底品牌标志、标题与说明、密码表单、当前服务器、辅助操作和轻量页脚。
- FieldGroup / Field / FieldLabel / InputGroup / InputGroupInput / InputGroupButton、Button、Spinner、FieldError 和 Alert 均复用 shadcn base-nova 源码组件。深浅主题沿用项目语义变量。
- 密码明文切换有44px触摸目标；主按钮52px、输入框54px，大字号自然增高。首次进入不自动聚焦；小高度视口将品牌区改为横向并减少顶部留白，页面可滚动。
- 首次核验、登录提交、服务器切换分别显示状态。密码错误贴近输入框；网络/服务错误内联显示，失败保留密码，编辑时清除旧错误。
- 放弃密码、更换服务器确认接入共享 AlertDialog；浏览器的换服务器说明接入共享 Drawer，替换原生弹窗；APK仍调用既有 configure 协议。
- 保留 token/generation/AbortController、离线退出标记和页面安全更新保护。未登录的会话401不再清空未提交密码；切服务器可以取消正在提交的登录，迟到响应不得恢复会话。

没有调整自选行情布局、sparkline 几何/采样/配色、精度或连接生命周期。专业图表和底部告警规则仍有各自既有控件，本轮不代表全App迁移。

## 截图复核

证据位于 [`a07-feedback/login-controls/`](a07-feedback/login-controls/)。

1. `before/`：原Ubuntu页面，原生密码框、外置显示按钮和相邻辅助按钮层级较弱。
2. `refinement/`：首轮品牌、表单与服务器区；检查发现显示密码图标视觉偏小，且默认 addon 负边距造成输入框内部约4px溢出。
3. `final-fixture/`：仅对登录作用域移除附件负边距，图标明确18px并保持44px目标；复查375/412px、深浅主题及14/21px根字号，无横向溢出。小视口截图保留大字号，提交可滚动到达。
4. `final-live/`：Ubuntu实际登录页与浏览器帮助抽屉；亲自查看412px深色及375px浅色，品牌、输入、主按钮和服务器信息对齐，无其他新布局问题。

## 检查结果

以下本地检查通过，页面错误为零：

```sh
cd web
npm run build
MOBILE_LOGIN_OUTPUT=/tmp/mw-login-round2 node tests/mobile-login.browser.cjs
node tests/mobile-app.browser.cjs
MOBILE_MORE_OUTPUT=/tmp/mw-login-more-regression node tests/mobile-more.browser.cjs
```

登录夹具覆盖初始延迟核验、必填验证、显示/隐藏、错误密码、网络错误、503、429、重连保留密码、提交禁用与重复提交保护、Android返回事件、放弃/换服务器确认、浏览器帮助、请求取消与迟到响应、成功登录/退出/过期、原生configure桥接、减少动态效果及窄屏大字号。运行时核对本范围所有可见输入/按钮来自shadcn组合，无业务写入。

已有App回归覆盖实际许可图表、导航复用、离线缓存、离线退出、会话过期、Service Worker更新和未提交密码保护、前台刷新及切服务器取消登录。“换服务器”断言适配新帮助抽屉：先确认底层已解除busy，再关闭顶层帮助继续操作，保留原时序覆盖。“更多”共享交互与抽屉回归通过。

实际Ubuntu环境使用私有凭据完成成功登录、进入更多、切换本地主题、退出、清空密码、浏览器服务器帮助；未试错误密码，未修改真实自选、告警或任务。截图不包含密码。实际环境页面错误和持久业务写入均为零。深色最终截图另以禁用Service Worker的全新上下文复拍，避免首次安装触发重载时截到不完整画面；实际认证检查启用Service Worker。

`git diff --check` 和项目skill校验通过。Skill仅补充登录状态、会话取消、默认附件负边距和实际图标尺寸这些已验证经验，未固化地址、镜像或密码。

浏览器缩小视口与模拟返回事件不能代表Android软键盘、物理返回键或真机触感；这些仍待手机确认。

## Ubuntu预览与回退

实际主机 `quant-server`，既有独立 task/project `mw-android-personal-v205`。预检可用内存7.2GiB、磁盘13GiB，仅替换web，未新增数据库或停止其他任务。

预览 <https://192.168.7.232:18445/m/>。Shell `e814e52dcbac3820`。现有APK可在“更多 → 检查更新”获取网页更新，无需新APK。

镜像 `market-watch-web:android-personal-v205-login-20261112`，实际容器固定ID：

```text
sha256:e4d6254497226bcb379c110709eb2e9e45bff8bf37d7f1306d5196ded478ad4a
```

通过 `mw-docker build` 构建，显式repo/context为本worktree、Dockerfile为`web/Dockerfile`，component=web，task/project=mw-android-personal-v205，purpose=acceptance，使用专用builder。web容器running；任务CA验证 `/readyz` 返回ready；实际网页shell与构建一致。

更新前run配置0600备份为 `before-login-run.json`；仅修改 `services.web.image`。旧数据页镜像保留：

```text
sha256:5c60084af0f02c150057317971afff2733faa5713f1a78dd0849ad52481369c1
```

启动/更新命令：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

停止（未执行）：同参数将末行改为 `stop web`。配置/镜像回退（未执行）：第一个配置换成同目录 `before-login-run.json`，执行同样up命令；不改数据库。
