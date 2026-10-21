# Multi-chart workspace restore black screen

User request: retire the completed Issue89 preview if safe, align the existing mwa instance with v1.26.4, then fix the saved five-chart workspace black screen. Preserve real data, configuration, ports, TLS, and the protected browser.

Risk: **F0**, compatible chart lifecycle fix. No schema, storage format, dependency, or backend change. Minimum checks: deterministic shipped-datafeed regression, nearby resolve/cancellation regressions, Ubuntu chart candidate smoke, real Playwright login and repeated reload against mwa, configuration/mount identity checks, PR CI, and self-review.

Acceptance:

- Issue89 retirement follows exact project ownership checks, private DB archive, and actual restore/content verification.
- mwa first runs clean v1.26.4 API, workers, Chart, and Web images before applying this patch.
- The saved XAUUSD workspace restores all five charts (60/5/1W/1D/240) with native data ready after reload, without `Value is null`.
- A temporarily unavailable native model cannot prevent other chart consumers from resolving; cancellation and workspace lifetime fences still hold.
- Saved workspace remains structurally equal through the browser check, and mwa environment/mounts and PG/gateway identity remain unchanged.

Evidence: [verification](../verification/multi-chart-restore-20261021/README.md).
