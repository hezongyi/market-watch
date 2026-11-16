# 切服务器后数据页提示跳闪核查

2026-11-15，当前工作树 `feat/managed-live-rollover-20261113`。本轮未修改应用代码或替换其他验收实例。

用户反馈：切换过服务器，第一次进入数据页仍出现上次更新时间提示并跳闪。

## 实测

先以 APK 信任 CA 读取各地址的网页版本，发现不同服务器并未提供相同的手机网页：

| Ubuntu 地址端口 | 网页 shell | 实测结果 |
| --- | --- | --- |
| 18446 | 27903fd4fb0f376f | 含旧的“上次读取…当前状态待核实”展示 |
| 18447 | 466ea0a9f2222971 | 当前版本，已无上述联网缓存提示 |
| 18445 | 972efa7556c85285 | 含旧的“当前显示上次读取”展示，未登录或修改 |

18443 未通过当前 APK 开发 CA 的证书链校验，未绕过证书校验来断言其版本。

[check.cjs](check.cjs) 使用隔离浏览器 profile，先登录、进入数据页使其保存本机缓存，再导航离开 origin 到另一服务器，切回后挂起自建列表 GET 请求，记录实际 DOM 插入和首行坐标，最后放开请求比对。所有页面非 GET API 请求拦截，不修改真实自选、数据集或告警。脚本仅使用私有凭据文件登录，不保存或输出登录态。

首次运行：

```sh
node docs/verification/mobile-server-data-flash-20261115/check.cjs
```

如期失败，见 [before.log](before.log)、[before-proof.json](before-proof.json)：

- 18446：捕获“操作状态 上次读取 2026/11/15 15:39 · 当前状态待核实”，首行 Y 261.30→172，位移约 -89.30px。截图 [缓存中](18446-cached.png)、[响应后](18446-fresh.png)。
- 18447：未捕获提示，首行 Y 127→127，位移 0px。

针对当前服务器启用真实 Service Worker 复验：

```sh
SERVER_CHECK_PORT=18447 SERVER_CHECK_SW=1 \
 node docs/verification/mobile-server-data-flash-20261115/check.cjs
```

通过，见 [current-sw.log](current-sw.log)、[sw-proof.json](sw-proof.json)。当前版本切回服务器读取缓存无提示、无首行位移。当前服务器图片 [缓存中](18447-cached.png)、[响应后](18447-fresh.png) 已目视核对。

## 结论与边界

可确定旧的 18446 实例仍会产生用户描述的症状，当前 18447 在相同操作和实际 SW 下无此症状。已通过异步问题询问用户实际切换的地址；若实际在 18447，则继续确认设备所用网页 shell/旧 SW，而不能仅凭此处复验把真机问题认定已修复。

目前不更新 18446/18445 或 18443：这些属于不同任务 project/后端/数据，不能把当前候选 web 跨实例覆盖。当前建议入口为 https://192.168.7.232:18447/m/data ，已有 APK 通过“更多 → 检查更新”应用网页更新。无需新 APK。

脚本模拟 origin 导航往返，不代表 Android 原生服务器选择器和物理设备生命周期已经验收。未执行 PR/CI/commit/tag、部署或生产操作。`git diff --check` 通过。
