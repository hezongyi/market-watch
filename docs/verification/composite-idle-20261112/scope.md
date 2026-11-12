# Enabled composite acquisition and idle CPU correction

Baseline: ba58ea1d79e6374d41acaf1bd3022279aec9dc05 (v2.0.7).
Branch: fix/composite-idle-20261112. User authorized repair and development deployment; no production, merge, tag, CI tracking or persistent-data deletion.

Risk F1: changes durable demand and important background acquisition/aggregation scheduling. No schema or persisted format change.

Accepted scope:
- An explicitly enabled composite head continues its target stream without browsers or active alerts. Off stops it; older revision-pinned consumers retain their identity and source-switch/frozen behavior.
- Retire development's independent EURUSD, XAUUSD, BTCUSDT collectors via saved off switches, retaining history, identifiers and shared ingestion. New bootstrap seeds retain records but default off; do not forcibly disable existing user installations on upgrade.
- Aggregate price content only for genuinely changed M1 starts, retaining coverage changes, volume corrections, observations, REST completed-minute confirmation and recovery.
- Empty fixed/display selection must not mutate fairness turns. Active work retains scheduling and locking.
- No-demand pricing must not repeatedly acquire/release an account lease. Preserve authentication probing, failure backoff and catalog serialization; bounded five-second discovery fallback.
- Separate composite-input and history-work notifications from chart publications. Commit delivery, rollback and lost-listener polling remain valid. Composite idle fallback two seconds; history five seconds. Active alert evaluation cadence is unchanged.

Minimum checks: focused SQLite regressions; isolated PostgreSQL compatibility/commit/rollback/concurrency tests; independent Standards and Spec review; owned backend candidate build; development deployment with config/source/image rollback retained; readyz, all roles, real three-composite quote + confirmed-tail progress, legacy inactivity, browser smoke, five-minute CPU/DB-rate sample after recovery. Prior CPU baseline had no live composite demand, so clearly disclose workload difference.

Host: Ubuntu quant-server, 4 CPU/16 GiB. Isolated task PostgreSQL project mw-composite-idle-20261112, loopback port 25474, 1 CPU/1 GiB, private credentials and retained volume. Existing mw-dev is the explicitly authorized deployment destination; other projects untouched.

Follow-up within idle-scan scope: profiling after the first deployment identified empty provider live/warm scans. Add committed provider-demand hints for new finite targets, subscriptions and prefetch-policy reconciliation; poll truly empty sources every five seconds. Valid live subscriptions (including not-yet-due) and waiting warm targets/foreground contention retain one-second service; warm progress .05s, errors 1s. No provider protocol or active cadence change.
