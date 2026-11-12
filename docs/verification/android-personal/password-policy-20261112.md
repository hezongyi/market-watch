# Android personal preview password

用户要求将手机登录密码设为四位数字。账户密码修改接口原限制六位，已改为最少四位；初次初始化密码策略未改。密码未写入仓库或验证记录，仅保存在实例数据库的 Argon2 哈希及任务私有凭据文件中。

`PYTHONPATH=backend pytest -q backend/tests/test_account_password.py` 通过，11 项。专用 API 镜像构建通过：`market-watch-api:android-personal-v205-four-digit-password`，`sha256:25063eae0ace586422d5adc1997c254d98212a8c8fd024195a2cea894c311d27`。仅更新 Ubuntu `quant-server` 上既有 `mw-android-personal-v205` API 服务，`/readyz` 返回 ready。通过当前有效密码及 CSRF 修改账户密码；API 返回成功，新密码登录与 `/api/session` 验证通过，旧密码返回 401。账户密码修改按现有逻辑撤销其他会话，手机需要重新登录。

实例：<https://192.168.7.232:18445/m/>。更新前配置保存在私有目录 `/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/before-password-policy-run.json`，权限 0600；旧镜像保留。未操作 Unraid、PR 或 CI。
