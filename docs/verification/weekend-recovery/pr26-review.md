# PR26 review and release preparation

PR: https://github.com/hezongyi/market-watch/pull/26. Fixed base: `e933ed4826a01b9fad3f203b5c241c187089c0a6`. Initial head: `6c5cba69431e6db6cf75bdded6c520f09ce2ef0e`. Standards and Spec reviewed independently using the code-review skill; final working-tree fixes were re-reviewed before merging.

## Standards

No documented hard violations. The initial P1 maintenance race was reproduced with the real watch evaluator: ready, Bid 1.20, REST maintenance, then Bid 1.30 crossing buy 1.25 produced one SignalRow before stream shutdown. Fixed by an atomic account maintenance barrier, rejecting subsequent publishing/confirmation successes, preserving the fault through disconnect/closed shutdown, and requiring a new claimed epoch before recovery.

Follow-up review identified loss of a later 401 when maintenance was already present. Unauthorized now wins over maintenance in startup/disconnect, stream-versus-REST shutdown, and both already-issued confirmation requests. Already-issued successes cannot clear maintenance, and no further pair is requested after a fault. Actual threaded worker and source-isolated PostgreSQL regressions cover these cases. The final Standards re-review reports no remaining confirmed blocker. Duplicated status-gate calculation is a nonblocking maintainability suggestion.

## Spec

The initial P2 incorrectly labelled excluded open/close boundary minutes as verified trading time. Fully closed interiors remain closed; adjoining nonclosed minutes now report unknown and still allow conservative collection. Daily, weekend, DST, explicit-maintenance and split-week continuity regressions cover the change. The final Spec re-review reports no remaining blocker.

## Verification and release boundary

Final source regression: **165 passed**. It uses real Ubuntu isolated PostgreSQL in project `mw-weekend-recovery-20261010`, with random test schemas. Native licensed toolbar lifetime and cache contracts pass; scoped Ruff and diff checks pass. The pre-review acceptance and its limits remain in README.md; formal tagged builds and production results are recorded separately.

Version metadata is advanced to v1.15.1. No schema migration, new process or new dependency. The user explicitly authorized fixes, merge, tag and formal production deployment. Existing production runtime configuration is preserved: no SG account/product applicability is inferred and no unreviewed session profile is enabled. Unconfigured evidence remains unknown.

Real OANDA market reopening, fresh Bid/Ask advancement and confirmed-M1 browser propagation remain external verification; weekend deployment cannot prove those conditions.

Final result: Standards 0 remaining blockers (1 nonblocking suggestion); Spec 0 remaining findings.
