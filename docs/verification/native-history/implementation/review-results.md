# Native history implementation review

Fixed baseline: `9596b25eda507ef708a327feb5271f238cdfdc0b` (v1.3.2).
First reviewed implementation: `1d9dc2912190dbe6e8456ff18129b0a1e493ac77`.
Policy: [R2 plan](../../../provider-native-history-buffer-plan.md).

## Standards

No documented hard violations found. One low-priority possible Duplicated Code:
`read` and `native_read` duplicated timing/context/activity-counter lifecycle,
with native reads missing the corresponding failure log. Adopted: both use
`_observed_read`, preserving separate demand algorithms and shared diagnostics.

## Spec

- P1: Later failed revalidation overwrote an earlier confirmed correction, so
  reload could be lost. Adopted: merge verified correction work, with a fixed
  three-callback/two-review regression (second review fails).
- P2: Native numeric/time fields were coerced from booleans, strings and floats.
  Adopted: explicit strict input-type validation and rejection regressions.
- P2: Database SELECT/housekeeping could exceed remaining request budget.
  Adopted: transaction-local PostgreSQL statement timeout, immediate expiry
  checks after checkout, and SKIP LOCKED access bookkeeping. Real PG tests cover
  a locked dataset and a waiter whose pool acquisition outlives its deadline.
  Existing API waiter bounds HTTP response; existing shared SQLAlchemy pool
  configuration still bounds residual thread checkout occupancy. No pool
  mutation or additional acquisition scheduler is introduced.

The initial independent report found 1 judgment-only Standards item and 3 Spec
items. These fixes require re-review and formal runtime acceptance; this record
is not a performance or completion claim.

Second Spec review at c9d12859 found one additional P1: revalidation superseded
by a newer delivered response remained unverified and silent. Adopted: retain
original demand/observation, show unresolved error, and allow one bounded check
per explicit public Refresh History action. Automatic review remains once per
late callback; ordinary SSE/new responses cannot consume the correction.
Standards re-review reports zero remaining findings.

Final independent Spec review at `fc8af766f44e5355e255a7c71b183ec14cb26feb`
reports no remaining concrete Spec findings. Subsequent refinement retains a
bounded list of 64 exact unresolved request/observation pairs. Negative checks
consume pending only after all proofs are current and mutually consistent;
confirmed revisions cause one public reload. Overflow is visibly unresolved
until workspace replacement. Independent VM checks confirmed consistent negative
proofs clear without reload and mixed proof versions remain pending.

User steering after baseline acceptance: investigate why cold gate failed and
seek a balanced return quantity. Added backend-only downward configuration
limits for cold E, first hot E and history hot E, preserving R2 defaults and
mandatory D/H. Candidate experiments are separately labeled; original 80-sample
performance result remains immutable. No frontend quantity policy is added.
