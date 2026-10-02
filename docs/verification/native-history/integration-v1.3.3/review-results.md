# Native history integration review

Fixed base:`dd9ba43a4abc09359c0a05aa12390ba1885978df`(Volume main/v1.3.3).
Initial integrated source:`5f7fed0159db80e99f4f0da280985c1a83d6ebd2`.
Review method:`code-review`skill, independent Standards/Spec agents. Initial
command:`git diff dd9ba43a4abc09359c0a05aa12390ba1885978df...HEAD`;
follow-ups reviewed the final lifecycle delta against`5f7fed0`.

## Standards

No documented hard violations against repository release, secret, licensed
library and scope rules. Snapshot integration preserves Volume metadata,
quantities and revisions from one statement. The connection/callback seam
serves a concrete requirement; both algorithms close snapshot transactions
before provider HTTP and optional failure rolls back only its SAVEPOINT.

Two low-priority judgment calls remain, neither blocks merge:

- Possible Speculative Generality: bridge correction generation is written but
  never read; correction identity checks provide actual fencing.
- Possible Duplicated Code: legacy/native read algorithms repeat the tail overlap
  count calculation. Shared extraction can be considered separately.

The initial Standards reviewer separately identified optional activation's
row-lock correctness problem; it was passed to Spec and fixed with regressions.
No new material smells or correctness concerns in the final fix delta.

## Spec

Initial review found two P1 correctness issues againstR2§4.9/§4.4:
optional activation could discard completed bars while waiting for locks or a
second checkout; cancellation/deadline prevented owned lease release. Four
original cases plus two pool-exhaustion cases reproduced those failures.

Final independent review found no residual concrete blockers: native and legacy
callbacks run only after a satisfied final snapshot, use its existing connection,
and wrap optional SQL/autoflush in a SAVEPOINT. Mandatory target remainsD+H,
with legacyN+H fallback; no provider HTTP is held in the transaction. Atomic
release preserves token/generation successor fencing. User-approved performance
limits and existing browser/image evidence boundaries remain unchanged.

Final full PG17 verification395passed/1skipped. Existing frontend40-script/build
checks remain valid because those inputs did not change during the final backend
fixes. No additional unasked scope or Volume interaction blocker was found.

Standards:0hard violations,2minor heuristics. Spec:0remaining blockers after
fixes. Review is source evidence; no combined-image runtime acceptance claimed.
