# Python LWMA presentation

P0: only native chart indicator metadata changes; calculation, saved layout format,
data retrieval and other indicators remain unchanged.

- LWMA inherits the main chart price formatter instead of forcing five decimals.
- New LWMA lines default to neutral gray `#787b86`; saved custom colors remain intact.

Verification (2026-11-17):

```sh
cd web
node tests/lwma-price-presentation.browser.cjs
node tests/supertrend-python-indicators.cjs
node tests/native-indicator-identity.cjs
```

All passed. The native browser regression failed against the original metadata,
then passed for 2/3/5 decimal symbols, manual precision changes, the chart's custom
formatter, and loading a previous layout with a saved custom color. It uses only
synthetic feeds and does not save deployed user settings. The licensed chart
library and Playwright browser must be installed locally to run it.
