# Fixed history and composite Python indicators

Candidate branch: `fix/python-observed-indicators-20261022`, based on integration `d0e439d`. Product commits `db0776f`, `9eec237`, `8def16a`, `2555ff8`; later evidence commits do not change behavior. This is F1 because it introduces separate persisted indicator/checkpoint semantics. There is **no DDL or migration**.

## Behavior

Professional charts explicitly calculate Python indicators over accepted observed OHLC (`observed_display_v1`). Coverage uncertainty is visible as **覆盖未核实**; forming prices are retractable **预览**, and genuine warmup is **样本不足**. Swing uses canonical MWH/MWC identity so the native library's uppercase tickers still find the same card and plots. The parent page forwards both policy and provisional flags through its trusted request validation.

Alerts, strategies, backtests and default fixed CSV retain `strict_confirmed_v1`. No published prices, coverage flags, historical versions, mappings, seams or strict checkpoints are rewritten. Display runs use `observed-v1:` algorithms; old fixed workers exclude them. Old display-task workers do not filter algorithms, so observed requests never enqueue their tasks. Long baseline replay retains existing paged workers; mutable snapshot suffix replay has an explicit 4000-row bound and fails with `DISPLAY_SUFFIX_CAPACITY_EXCEEDED` beyond it.

The independent Spec review found two P1s: mutable composite snapshot prices could be bypassed by durable foreground replay, and a retained snapshot's forming clock could drift after period closure. Both are fixed in `9eec237`, with regressions. Standards found no blocking documented violation. Real browser validation then found the parent's dropped fields; `8def16a` fixes that, with actual parent-handler regression and independent follow-up review.

Real mwa monthly validation additionally exposed repeated M1 aggregation: three studies made seven identical monthly reads, exceeding the HTTP budget and exhausting the two-connection pool during concurrent page initialization. `2555ff8` shares immutable price pages within a request and directly reuses an accepted page covering the required suffix. Snapshot, revision, seed, end and capacity fences remain. Both reviewers found no blocking issue ([follow-up](suffix-review.txt)). Read-count regressions accompany the original numeric, frozen-snapshot, pagination and state-isolation oracles.

## Checks

- **144 passed**: observed indicators, fixed indicators/display, composite alerts and indicator state.
- [**8 PostgreSQL tests passed, no skips**](postgres-final.txt): real PG 14.24, separate task schema, long paged replay, concurrent sharing, lease fencing, strict/observed isolation and mutable snapshot behavior.
- [Actual v1.26.5 application compatibility](old-compatibility.txt): strict result series unchanged; old worker refuses observed run. [Reproducible script](old-compatibility.py).
- Changed-file Ruff, `git diff --check`, Web production build and nine relevant Node suites pass. Existing Web chunk-size warning remains.
- [Isolated real-login browser](r1-browser.json): synthetic EURUSD/XAUUSD D1, native Swing/EMA/RSI have actual values; known 6-bar Swing intervals match cards, quality visible, no page errors. [EURUSD screenshot](r1-eurusd.png), [XAUUSD screenshot](r1-xauusd.png).
- [Monthly before](monthly-before-profile.txt) / [after](monthly-after-profile.txt): real mwa three-study MN profile, 26.752s → 5.416s and seven → one price-page read. This is one smoke observation under shared host load, not a p95 or long-term performance guarantee.

## Ubuntu isolated instance

Host `quant-server`, local Docker project/task `mw-python-indicators-20261022`, main `https://localhost:18501`, chart `https://localhost:18502`. Independent PG volume/network/database/credentials. [Fixture](r1-fixture.py) refuses other tasks and disables external streams/delivery. Protected mwa profiles were not connected or changed.

From this worktree: `python3 deploy/ubuntu/mw_docker.py preview status|up|stop --task mw-python-indicators-20261022 --project mw-python-indicators-20261022`. The latest API-only image override is private at `~/.local/share/market-watch-docker/previews/mw-python-indicators-20261022/suffix-api-override.json`; reapply it with that task's `compose.json` when restarting to preserve the last suffix fix. Default preview up uses the earlier registered API image. No task resource cleanup has been performed while review/integration is pending.

## Shared mwa

Ubuntu `quant-server`, existing project `mw-issue75-v2-20261018`, [workspace](https://192.168.7.232:18280/advanced-charts/7d72eead-6be5-41a4-b3d5-bfdfff98b2bb), chart `https://192.168.7.232:18281`.

Only **API, history-worker, market-stream-worker, Chart and Web** were replaced. history-worker executes fixed/display indicator jobs. [Images](mwa-images.json) record clean-source image IDs; [runtime audit](mwa-runtime-audit.json) checks 15 running services, API/PG healthy, exactly five intended replacements, matching environments, mounts, ports and networks. DB/gateway and other workers retain their containers. Docker inspect returned gateway mounts in a different order; comparison sorts by destination and proves the same container/mount definitions.

No seed, migration, reset, credential/provider configuration overwrite, volume replacement or protected-profile operation ran. Browser tests use fresh contexts and block workspace/preference saves, while allowing normal data, demand and calculation-cache activity. This does not claim zero database writes.

[Platform/history matrix](mwa-platform-history.json) contains 20 successful groups: EURUSD/XAUUSD × platform/fixed history × H1/H4/D1/W1/MN, each with native Swing/EMA/RSI values or correct monthly insufficiency. [Composite matrix](mwa-composites.json) passes all 10 corresponding EURUSD/XAUUSD groups on final API source; zero HTTP failures, no page errors, workspace unchanged. Composite current buckets carry preview status. Operation closeout follows its final run. No PR push/update, main merge, formal tag or production deployment is authorized by this verification.


Durable existing start/status/stop: `python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`. Its candidate overlay now pins the five new images. Round-specific private inventory/config and original rollback are under `/home/quant/repos/.mwa-python-indicators-20261022/` (mode 0700). `python3 .../operate.py up|audit` targets only the five application services. To return to the pre-task applications, use `python3 .../operate.py rollback` and restore `previous-candidate-override.json` to the durable manager's `candidate-override.json`; retain the PG volume and observed caches. Do not invoke the manager's historical whole-stack rollback. Both old-application and PG tests verify strict compatibility; no destructive DB downgrade is required.
