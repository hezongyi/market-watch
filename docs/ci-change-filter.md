# CI 按变更内容分流

纯文档 PR 和 main push 不再启动 PostgreSQL、安装应用依赖、构建前端或跑浏览器／Compose 检查。只运行轻量的 Git 差异分类、分类器回归和必需状态汇报。GitHub 仍会显示 CI 记录，不会完全消失。

## 判定范围

- 根目录 Markdown，以及 docs、deploy、Issue／PR 模板中的 Markdown，属于文档；docs 下的说明 RST、截图、SVG 和 PDF 也属于文档。
- docs 下的 Python、Shell、JSON 等不自动算作纯文档。文档混有代码、配置或依赖修改时，正常运行相关检查。
- 仅修改 `pyproject.toml` 的 `project.version`，解析后其余 TOML 内容完全相同，才免跑后端全集。仍做运维测试、前端构建／浏览器回归和 Compose 检查。依赖、构建配置、迁移或后端代码变更仍触发后端全集。
- PR 使用 merge-base 计算自身差异；main push 使用上次提交与本次提交的实际差异。新建引用无旧提交时检查全部输入；删除路径保留，避免把代码移动到文档目录后误判。

分类由 `.github/scripts/ci_changes.py` 执行，只有 Python 标准库和 Git 依赖。分类器读不到提交或无法产生分类时，CI 失败，不默认跳过。

## 保留合并门禁

main 分支仍要求 `backend`、`web`、`compose` 三个状态，无需调整保护规则。重任务分为 Backend checks、Web checks、Compose checks；三个原名状态由最终汇报任务生成：

- 分类成功且为纯文档：确认对应重任务确实 skipped，返回成功。
- 分类成功且包含非文档修改：对应检查必须 success，才能返回成功。
- 分类失败／取消、输出缺失，或重任务失败／意外跳过：返回失败。

因此不用 workflow 的 `paths-ignore` 跳过整条流水线，避免分支保护一直等待没有生成的状态。汇报逻辑位于 `.github/scripts/ci_required.sh`，与真实 Git 历史分类一起做回归。

## 本地验证

```bash
python -m unittest discover -s tests/ops -p test_ci_changes.py -v
python -m ruff check .github/scripts/ci_changes.py tests/ops/test_ci_changes.py
bash -n .github/scripts/ci_required.sh
```

本次改变 CI 策略，不改应用代码、依赖或生产配置，不移动 `v1.25.9`。后续首次纯文档 PR 仍应查看实际分类输出与三个最终状态，确认重任务按预期 skipped。
