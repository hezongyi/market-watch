# Two-axis review

Skill: [code-review](/home/quant/.agents/skills/code-review/SKILL.md).
Implementation baseline: `b1e6e27`; reviews exclude unrelated changes already present at that baseline.
Spec sources: `docs/issues/oanda-rest-native-history-20261015.md`, ADR 0004,
Swing acceptance/plan and `docs/provider-swing-evaluation-boundary-20261016.md`.
Standards sources: `AGENTS.md`, `CONTEXT.md`, applicable ADRs and the skill's labelled smell baseline.

## Standards

Initial review through `b5a800e`: no hard documented-standard violations.
One nonblocking heuristic: repeated binding-field lists in the indicator coordinator
could require synchronized edits when a future fencing field is added. No current incorrect field was identified.

Additional reviews of the current-high-period clock fix (`48ba186`) and historical-prefix
reuse fix (`0f5eb9f`): no hard violations and no additional smells.
The clock review noted that `boundary_evidence.mode=count_to` would be imprecise
when `to` is absent; the committed implementation now reports `count_latest` for that case.

The first-price source cutoff fix (`27c9dde`): no hard violations and no new smells.

## Spec

Initial review reproduced a blocking high-period snapshot defect: API `min(before, now)`
clipped valid D1/W1/MN chart labels even though the trusted price credential admitted
the source candle. `b4e712a` fixes it; six EMA/Swing parameterized regressions cover the three periods.
Follow-up through `89cebe8`: no remaining findings. An independent legacy-writer probe
confirmed revision-bound cache invalidation and equality with full-batch EMA.
An independent historical Swing probe confirmed that paging clips visible rows while
retaining the snapshot evaluation end and fixed statistics origin.

Clock-fix follow-up (`48ba186`): no blocking findings. An independent 4,000-row D1
probe confirmed the initial request omits `to`, the subsequent historical request supplies
an exclusive source cursor, returned coordinates satisfy both cutoffs, and coverage starts
at an actually retained candle.

Prefix-reuse follow-up (`0f5eb9f`): no blocking findings. Reuse requires the same history
epoch, a cache revision not newer than the observation and a retained last source start
strictly greater than the requested end. Independent counterexamples confirmed that a
window including the mutable tail and a correction inside a historical window both
reload inputs. Legacy epochs remain tied to an exact revision.

The first-price source cutoff fix (`27c9dde`): the initial ordinary/native price path
had still excluded valid current D1/W1/MN candles with chart dates after the UTC wall clock.
Independent empty-database probes through the real read/fetch path now pass all six paths;
explicit historical before excludes the current candle. Pending shared owners wait for
the existing collector, and the source cutoff ContextVar resets after exceptions.
An independently derived 756-case calendar enumeration covers four time zones, custom
alignments, DST and week/month/year boundaries. No remaining blocking findings.
Yahoo's similar date-label risk is tracked separately and is outside this OANDA fix.

Totals: Standards 0 hard findings, 1 initial nonblocking heuristic; Spec 2 blocking findings fixed,
0 remaining findings. Reviews do not replace candidate runtime acceptance.

## Intraday clock recovery and candle handoff follow-up

Standards (`c622b11` and `b2f57f0`): 0 hard violations, 0 new smells. The native
OANDA protocol helper limits recovery to one exact future-to rejection and preserves
the original deadline. Actual successful requests determine evidence mode; all OANDA
periods bound coverage by the actual observation and retained calendar label.

Spec: the initial all-period cursor comparison still failed a 200-ms queued request
that crossed a second; the supplier clock was 500 ms behind. The explicit future-to
recovery fixes real ordinary/native cold reads and cached-page slot waits. A second
independent count=1 minute-handoff probe found that the latest candle could equal
the exclusive before, be correctly filtered, then trigger no-progress. The final
change permits one explicit request at the unchanged cursor; repeated no-progress
still fails. It never admits the excluded candle or extends the budget.

Independent cold ordinary/native, cached queue, future-row filtering, multi-page
explicit cursor and exact observed==before probes all passed after the fixes.
The final three-file regression suite passed 134 tests; the initial clock extension
was 12 failed / 12 passed, and the minute-handoff cases were 4 failed / 2 passed.
No remaining blockers on either review axis; runtime acceptance remains separate.
