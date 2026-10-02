# Volume implementation review

Baseline: `v1.3.2`, `9596b25eda507ef708a327feb5271f238cdfdc0b`.
Final runtime source: `fe370c206402aa048bf7c7adbd08d0642e9085ef`.
Spec: [Volume R2](../../volume-repair-plan.md).
Skill: `/home/quant/.agents/skills/code-review/SKILL.md`.

## Standards

Independent Standards review found no hard documented-standard violations.
The initial review noted one optional low-priority parsing-duplication smell;
it was not a blocker and no broad refactor was introduced. Follow-up review
of partial publication, epoch-zero detection and explicit `Ingestion` changes
found zero new material smells or hard violations.

The Standards reviewer separately flagged a correctness concern about tick
quote polling. It was passed to the Spec reviewer rather than ranked as a
standards violation.

## Spec

The initial implementation review identified four findings around publication
proof and retry-range fencing. They were corrected with regressions in
`cd0cfec`; the first follow-up found no remaining blockers.

Real-environment testing then exposed an incomplete existing price bucket
that could leave volume publication pending forever. `5fea483` records the
unpublishable range as partial; `f4a16e4` makes epoch-zero checks NULL-safe.
`9371b41` prevents volume-only maintenance/import observations from invoking
historical price-watch evaluation.

The next review found one P1: that gate had also suppressed independent live
tick quotes when closed-M1 prices did not change. `fe370c2` removes the gate
from quote polling while retaining it for historical evaluation. The added
test proves a volume-only M1 observation still obtains a fresh quote and a
real quote crossing triggers the tick watch. Independent final Spec review
confirmed the fix; its focused run passed 15 tests. The root focused run
passed 29 tests; final full run passed 335 with one skip.

Final Spec review: no remaining blockers. Full PostgreSQL test output and
real runtime limitations are documented separately; review is not runtime
acceptance.
