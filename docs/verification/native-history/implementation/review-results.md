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
