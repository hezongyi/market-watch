# Catalog paths and G1 evidence — in progress

The approved plan remains the authority. A path existing in this table does not
establish that its browser latency or full A1–A16 acceptance has passed.

| Catalog | Provider / managed exact path | Fixed history / confirmed composite path | Provisional composite |
| --- | --- | --- | --- |
| SMA | Shared frozen prefix + existing state/result/checkpoint engine | Full-origin existing TA-Lib oracle, bounded foreground replay; durable worker | Existing snapshot-bound display suffix |
| EMA | Same, target-spec recursive state only | Same full-origin oracle; no window initialization | Same |
| LWMA | Same | Same full-origin oracle; preserves finite dependencies | Same |
| BBANDS | Same, all three plots together | Same full-origin oracle and dependency evidence | Same |
| RSI | Same, target-spec recursive state only | Same full-origin oracle | Same |
| MACD | Same, three plots and target-spec seed | Same full-origin oracle | Same |
| ATR | Same, target-spec recursive state only | Same full-origin oracle | Same |
| STOCH | Same, both output warmup masks | Same full-origin oracle and dependency evidence | Same |
| SWING_SR_V1 | Existing complete batch oracle/presentation | Existing fixed SwingState replay, including statistics | Existing display_step and snapshot-bound suffix |
| SUPERTREND_PINE_V1 | Existing versioned state engine | Existing fixed Supertrend replay, preserving every plot | Existing display_step and snapshot-bound suffix |

Foreground fixed replay admits only complete confirmed inputs covering the
accepted page, with no provisional snapshot observations, and at most 6,000 rows.
Inputs use the existing global 250,000-row / 16-entry cache; results share the
existing 1.5-million-weighted-value / 16-entry budget. Immutable over-budget
prefixes cache their refusal so pending polls cannot repeatedly scan them.
Long/unavailable inputs keep real background progress. No display batch is
published as a resumable checkpoint. State/checkpoint numerical formats remain
unchanged; dependency updates are shared with the existing state engine.

## Measured decision trail

- Managed LWMA add: native polling baseline p95 609.2 ms; event subscription
  338.1 ms; shared exact inputs/results 277.0 ms, n=30 each. This passes only
  the declared short synthetic managed group.
- Fixed history LWMA, 5,760 M1 rows: queue baseline n=30, 23 failed to render
  within 5 s (failures retained). Found parent forwarding omitted consumer
  fields. Corrected forwarding plus committed queue notifications and bounded
  prompt retries: n=30, failures=0, p95 952 ms.
- Bounded state replay without waiting for durable completion: n=30,
  failures=0, p95 535.4 ms. A separate quiet run: n=30, failures=0,
  p95 670 ms. Both fail the 300 ms target. The groups use successive unused
  parameter ranges and remain separate in the raw JSON; no sample is removed.
- Profile hypothesis verified locally: full-origin LWMA150 over 5,760 rows,
  existing state replay 146.7 ms versus existing TA-Lib oracle plus shared
  dependency evidence 43.9 ms. This is one exploratory numerical timing, not
  a browser p95. Standard eight now use the existing oracle for bounded display
  replay. Native/browser timing after this change remains pending.
- 102 targeted numerical/input/snapshot tests passed, including all ten catalog
  items and standard-eight null/gap/seam dependency comparisons. The existing
  oracle tolerance is absolute 1e-8 / relative 1e-10; masks/identities and
  dependency metadata compare exactly. Swing/Supertrend retain their state path.

Remaining G1 work: four kinds and all required actions, EMA500, complex new
parameters, long origins, cold restoration, recovering, input/seed misses,
per-process provider input evidence, and pressure. Do not treat this partial
backend selection as closure of G1 or as proof that no further Adapter is needed.

## Follow-up diagnosis (2026-10-17)

See [performance analysis](performance-analysis-20261017.md) for the retained full-origin oracle history group (p95 496.5 ms), a same-viewport new oracle baseline (459.1 ms), and the deployed dependency-window candidate (371.0 ms, repeated uninstrumented group 459.7 ms). All groups have n=30 with no render failures and all misses retained; none establishes the 300 ms SLO. Actual API instrumentation found long generation-2 GC pauses across read/compute/request-wait boundaries. Bounded object/result compaction and redundant SQL/JSON work should be evaluated before a broad browser algorithm port. Temporary diagnostic GC suppression and worker-stop groups are causal probes only. No catalog path or revised SLO has been accepted by this analysis.

## Subsequent authorization (2026-10-17)

The user subsequently authorized scenario budgets and continued implementation. [Plan §3](../../chart-indicator-parity-plan-20261016.md) now defines reusable/new standard/new complex, warm/cold layout and long-origin budgets. The diagnostic groups above retain their original targets and verdicts. New acceptance must predeclare its scenario and budget revision and remeasure; a catalog path is not accepted merely because a historical sample falls below a new limit. G1 and the outstanding correctness/resource matrix remain in progress.
