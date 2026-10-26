# AkShare A-share Adjustment Data Verification

Date: 2026-10-25 UTC
Scope: Verify whether `stock_zh_a_hist_tx` (Tencent) and `stock_zh_a_daily` (Sina) expose data usable for locally applying qfq/hfq adjustments. No application code or acceptance instance was changed.

## Conclusion

- **Sina `stock_zh_a_daily`: yes.** AkShare 1.19.3 accepts `adjust="qfq-factor"` and `adjust="hfq-factor"`. Each returns a date-indexed factor column (`qfq_factor` or `hfq_factor`), separate from the ordinary unadjusted OHLCV response. The pinned implementation applies qfq as raw OHLC divided by `qfq_factor`, and hfq as raw OHLC multiplied by `hfq_factor`, carrying factors across dates with forward fill. The factors are available through a separate API call; they are not included in the `adjust=""` response.
- **Tencent `stock_zh_a_hist_tx`: no explicit factor feed in the AkShare interface.** It accepts `adjust="qfq"` and `adjust="hfq"` and returns the corresponding adjusted OHLCV rows. It does not expose a factor mode or factor column. Comparing Tencent adjusted prices with Tencent raw prices on matching dates can yield an approximate per-date price ratio, but that is not a corporate-action factor feed and is sensitive to price rounding. Tencent adjusted OHLC can be used directly for display; do not treat it as verified factors for adjusting another provider's raw series.
- **Practical implication:** for a local adjustment pipeline based on raw bars, Sina provides the needed factor series at the AkShare API level. Tencent can provide adjusted price histories for comparison, but not the explicit factor series requested here. This confirms interface capability, not factor correctness, completeness, update policy, or production reliability.

## Verification

The project virtual environment is pinned to AkShare 1.19.3 (`requirements.lock`). Its installed source was inspected at `.venv/lib/python3.11/site-packages/akshare/stock/stock_zh_a_sina.py` and `.../stock_feature/stock_hist_tx.py`.

Live development-egress probe, symbol `sz000002`, run 2026-10-25 UTC:

| Call | Result |
|---|---|
| Tencent raw, `stock_zh_a_hist_tx(..., adjust="")`, 2026-09-20 through 2026-10-25 | 19 rows; fields `date/open/close/high/low/volume/turnover/amount` |
| Tencent qfq, same symbol/window | 19 rows; same fields, with no factor field. Recent values matched raw for this window. |
| Tencent raw and qfq, 2020 calendar year | Returned distinct OHLC values on 2020-01-02: raw close 32.56, qfq close 28.65; both series only expose adjusted bars, not a factor column. |
| Sina qfq factor, `stock_zh_a_daily("sz000002", adjust="qfq-factor")` | 37 rows; fields `date/qfq_factor` |
| Sina hfq factor, same symbol with `adjust="hfq-factor"` | 37 rows; fields `date/hfq_factor` |

The Sina factor probe includes historical event dates and a `1900-01-01` sentinel row. It verifies a live response and schema for one symbol only. It does not establish factor correctness against official corporate actions, complete coverage for all listings, or how promptly revisions appear. The recent Tencent equality is expected when no adjustment event falls in that interval and is not evidence that qfq is unsupported.

## Sources

1. AkShare 1.19.3 pinned package source: `stock/stock_zh_a_sina.py`, function `stock_zh_a_daily`; factor modes, output fields, and price application logic.
2. AkShare 1.19.3 pinned package source: `stock_feature/stock_hist_tx.py`, function `stock_zh_a_hist_tx`; accepted adjustment modes and output schema.
3. AkShare official stock docs: <https://akshare.akfamily.xyz/data/stock/stock.html>, sections “历史行情数据-新浪” and “历史行情数据-腾讯”. The Sina section documents qfq/hfq factor modes; the Tencent section documents raw/qfq/hfq history modes.
4. AkShare 1.19.3 first-party source: <https://github.com/akfamily/akshare/blob/release-v1.19.3/akshare/stock/stock_zh_a_sina.py> and <https://github.com/akfamily/akshare/blob/release-v1.19.3/akshare/stock_feature/stock_hist_tx.py>.

## Limits and follow-up

Before relying on locally adjusted output, compare Sina-factor-derived qfq/hfq OHLC against Sina's own qfq/hfq bars over multiple corporate-action dates and representative symbols, and record the factor retrieval time/version. Keep raw bars and factor snapshots separately versioned. Do not infer that Sina factors are suitable for adjusting Tencent or another source's raw series without cross-source validation.

## 2026-10-25 HK live verification

Using the repository `.venv` pinned to AkShare 1.19.3, the isolated `alerts.akshare_worker` was called directly (read-only, without application DB scheduling) for `HKEX:00700`:

| Call | Result |
|---|---|
| `stock_hk_daily(symbol="00700", adjust="")` | 5,499 rows, fields `date/open/high/low/close/volume/amount`; range 2004-06-16 through 2026-10-23 |
| `stock_hk_daily(symbol="00700", adjust="qfq")` | 5,496 rows with the same fields and date range endpoints |
| `stock_hk_daily(symbol="00700", adjust="qfq-factor")` | 28 rows, fields `date/qfq_factor`; includes `1900-01-01` sentinel factor `0.1662917942` |

On 5,496 matching dates, applying the latest factor whose date is on or before each bar (`raw OHLC * factor`) matched all 21,984 OHLC values from Sina qfq within `0.00011`; maximum absolute difference was `0.00005`, consistent with Sina rounding adjusted prices to four decimals. The sentinel is a factor baseline, not a market bar. This verifies the returned shape and formula for one liquid HK listing at this observation time; it does not establish all-symbol availability or vendor completeness.

This probe bypassed only the app's shared request-slot database because the developer SQLite file had not been initialized (`preferences` table absent). It did not touch the long-running `mwa` instance or local user configuration.
