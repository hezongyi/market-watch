# Independent F1 review

Reviewed baseline ba58ea1d against fix/composite-idle-20261112 implementation, including the scope and regression tests.

Standards: one P2 finding — cached catalog + no demand skipped authentication probes, then a follow-up found that a not-yet-due persisted auth hold was reported idle, clearing runtime errors. Fixed by retaining the bounded probe path and returning persisted auth-hold activity from its existing transaction. A not-due hold reports waiting_input; only successful authentication clears it. Added real-owner regression. Final independent review: no remaining findings.

Spec: same authentication-probe finding. Fixed and independently re-reviewed. Persistent enabled heads, pinned revisions, changed-minute propagation and retained volume/coverage/observation semantics, scoped notification and polling behavior all accepted. Final review: no remaining findings.

The common database fixture now explicitly enables existing legacy instruments for their compatibility contracts. Separate fresh-engine tests verify new installations seed retained legacy records off and bootstrap preserves persisted choices. No schema changes.

Local targeted suite: 240 passed. Isolated PostgreSQL suite: 115 passed, including actual notification commit/rollback, capacity and fencing, source correction and confirmed-tail alerts, managed switches, browser-independent enabled-head demand and no idle fairness writes. CI was not queried or tracked.

A preliminary full-suite attempt first lacked the declared mcp dependency. After installing it, the run was interrupted after finding tests using old default-on legacy fixtures and the former broad aggregation expectation (87 failed, 366 passed, 117 skipped). Those compatibility fixtures and the narrower aggregation contract were corrected; the final 240-test targeted run above includes the modified contracts and affected ingestion, collection, aggregation, switching, wakeup and alert paths. A full repository green run is not claimed.
