# Yahoo US Equity Adjustment Basis Verification

Date: 2026-10-25 UTC
Scope: Inspect the project's pinned yfinance 1.7.0 behavior and current Yahoo adapter paths for US equities/ETFs. No application code or acceptance instance was changed.

## Conclusion

- The platform chart requests Yahoo history with `auto_adjust=True` for equities and ETFs, `actions=True`, and `back_adjust=False`. yfinance applies `Adj Close / Close` to Open/High/Low and replaces Close with Adj Close. Thus the platform receives adjusted OHLC directly; its market cache is not raw Yahoo OHLC.
- The managed/self-built acquisition path sets `auto_adjust=False` and `actions=True`. yfinance 1.7.0 can return raw Yahoo OHLC together with `Adj Close`, `Dividends`, `Stock Splits`, and (where supplied) `Capital Gains`. This provides a same-source adjustment ratio `Adj Close / Close` that can reproduce yfinance's `auto_adjust` OHLC transformation when Yahoo supplies a distinct adjusted close.
- **The current project does not preserve this basis.** The shared parser reads OHLC and Volume only. It does not store Adj Close or the action columns in managed history. The current self-built Yahoo series therefore cannot later recalculate qfq from its persisted data; the basis has been discarded.
- For an implementation matching Yahoo/yfinance's own adjusted display, persist `Adj Close` or the per-bar ratio plus the event columns alongside raw Yahoo bars. Prefer the ratio for reproducing Yahoo's adjusted OHLC. Treat Dividends/Splits/Capital Gains as audit data; do not assume they fully reproduce Yahoo's unpublished adjustment calculation.
- Do not label Yahoo `auto_adjust=False` prices as guaranteed original execution prices. Yahoo chart OHLC may already reflect split normalization. This path means “not adjusted by yfinance for Adj Close”; it does not promise a fully unadjusted corporate-action history.
- yfinance is an open-source client of Yahoo's public interfaces, not an official Yahoo data SDK with a completeness or stability guarantee. Store source, retrieval time, and revisions for both bars and adjustment basis.

## Current project behavior

`backend/alerts/provider_yahoo.py` sets `_history(..., auto_adjust=meta["adjustment"] == "auto", back_adjust=False, actions=True, repair=False)`.

- For platform equity/ETF metadata, `_metadata` sets `adjustment="auto"`; the chart path therefore receives adjusted OHLC.
- `archive_page` restricts managed Yahoo identities to adjustment `none` or `supplier` and passes `meta["adjustment"]="supplier"`, which makes `auto_adjust=False` while keeping `actions=True`.
- `_rows` reads Open/High/Low/Close and Volume, discards Adj Close and Dividends/Stock Splits/Capital Gains, and builds the bars. The parser intentionally skips action-only rows with no OHLC, so those events are not persisted either.

## Source behavior

The pinned yfinance 1.7.0 `Ticker.history` documentation in source describes `auto_adjust` as “Adjust all OHLC automatically”; `actions=True` includes event data. The implementation of `auto_adjust` computes `ratio = Adj Close / Close`, multiplies Open/High/Low by that ratio, and renames Adj Close to Close. The history parser places Yahoo's `indicators.adjclose` in Adj Close when present; otherwise it falls back to Close, so a column named Adj Close does not prove the upstream returned an independently adjusted series.

The `actions` response is parsed into Dividends, Stock Splits, and Capital Gains. Their presence is useful to audit price jumps and corporate actions, but the documented yfinance behavior does not define a complete, independently reproducible Yahoo factor algorithm from those events alone.

## Recommended Yahoo integration

Keep the platform's temporary viewing path on supplier `auto_adjust=True` if its desired default is qfq-style display. For self-built history, acquire `auto_adjust=False`, preserve the raw Yahoo OHLC and Volume, and add a separately versioned adjustment-basis record containing Adj Close (or `Adj Close / Close`) and action events. At chart time, calculate adjusted OHLC from the stored same-source ratio. If Adj Close is missing or equal to Close because the upstream did not supply an independent series, report qfq basis unavailable instead of silently claiming adjusted data.

## Sources

1. Project dependency pin: `requirements.lock`, `yfinance==1.7.0`.
2. Project adapter: `backend/alerts/provider_yahoo.py`, `_metadata`, `_history`, `archive_page`, `_rows`.
3. yfinance 1.7.0 history source: <https://github.com/ranaroussi/yfinance/blob/1.7.0/yfinance/scrapers/history.py#L105-L139> and <https://github.com/ranaroussi/yfinance/blob/1.7.0/yfinance/scrapers/history.py#L437-L445>.
4. yfinance 1.7.0 adjustment and chart parsing source: <https://github.com/ranaroussi/yfinance/blob/1.7.0/yfinance/utils.py#L506-L523> and <https://github.com/ranaroussi/yfinance/blob/1.7.0/yfinance/utils.py#L550-L620>.
5. yfinance 1.7.0 project README and usage restrictions: <https://github.com/ranaroussi/yfinance/tree/1.7.0>.

## Related Sina note

For the proposed A/HK self-built route, AkShare 1.19.3 exposes `qfq-factor` separately for both A shares (`stock_zh_a_daily`) and HK shares (`stock_hk_daily`). Its formulas differ: A-share code divides raw OHLC by `qfq_factor`; HK code multiplies raw OHLC by `qfq_factor`. HK hfq factors additionally include a cash offset, although qfq is the scope of the proposed display path. Keep market-specific formula tests and do not share an assumed factor convention. See the pinned source files `akshare/stock/stock_zh_a_sina.py` and `akshare/stock/stock_hk_sina.py`.
