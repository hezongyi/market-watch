# Independent F1 review

Reviewed baseline ba58ea1d against fix/composite-idle-20261112 implementation, including the scope and regression tests.

Standards: one P2 finding — cached catalog + no demand skipped authentication probes, then a follow-up found that a not-yet-due persisted auth hold was reported idle, clearing runtime errors. Fixed by retaining the bounded probe path and returning persisted auth-hold activity from its existing transaction. A not-due hold reports waiting_input; only successful authentication clears it. Added real-owner regression. Final independent review: no remaining findings.

Spec: same authentication-probe finding. Fixed and independently re-reviewed. Persistent enabled heads, pinned revisions, changed-minute propagation and retained volume/coverage/observation semantics, scoped notification and polling behavior all accepted. Final review: no remaining findings.

The common database fixture now explicitly enables existing legacy instruments for their compatibility contracts. Separate fresh-engine tests verify new installations seed retained legacy records off and bootstrap preserves persisted choices. No schema changes.

Local targeted suite: 240 passed. Isolated PostgreSQL suite: 115 passed, including actual notification commit/rollback, capacity and fencing, source correction and confirmed-tail alerts, managed switches, browser-independent enabled-head demand and no idle fairness writes. CI was not queried or tracked.

A preliminary full-suite attempt first lacked the declared mcp dependency. After installing it, the run was interrupted after finding tests using old default-on legacy fixtures and the former broad aggregation expectation (87 failed, 366 passed, 117 skipped). Those compatibility fixtures and the narrower aggregation contract were corrected; the final 240-test targeted run above includes the modified contracts and affected ingestion, collection, aggregation, switching, wakeup and alert paths. A full repository green run is not claimed.

Provider follow-up: 95 focused local checks passed. Both independent reviewers found that `progressed=False` also includes valid not-yet-due warm targets; fixed by reporting separate activity, retaining one-second service for pending/foreground-busy targets. Added a real persisted future-due target regression. Both final incremental reviews passed. Actual PG connection budget before extra listeners: 42/80 including five server background processes and the read-only checker; verify after deployment.

Final provider PostgreSQL supplement: 37 passed. Additional alert contracts after compatibility changes: 109 passed / 1 skipped, including HTTP/MCP legacy read lifecycle. Core 115-pass PostgreSQL and 240-pass local results remain the targeted baseline; suites overlap.

Post-deployment measurement caught a listener cost regression: one hundred-millisecond stop check per provider listener increased idle Python wakeups. Regression reproduced as 20 empty notification polls in a two-second wait. The maximum blocking slice is now .5s (four polls); actual notifications still wake immediately, shorter business deadlines are unchanged, and shutdown remains within supervisor budgets. Both independent reviews passed this follow-up. The intermediate r2 CPU sample is retained privately and is not used to claim optimization success.
