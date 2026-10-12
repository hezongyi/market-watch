# Swing V1 browser evidence

Authenticated Ubuntu Docker application; frozen OANDA prices without adjustment.
The screenshot comparison checks dots, finite bridges and four legend/axis values.
The light card capture uses 375px width. The two-chart capture shows separate study ownership.

- [Dark comparison](swing-application-comparison.png)
- [Two charts](swing-application-two-charts.png)
- [Narrow light card](swing-application-narrow-light.png)
- [PR review blocker verification](swing-review-blockers.png)
- [Sanitized browser assertions](browser-acceptance.json)

See [implementation acceptance](../../swing-sr-implementation-acceptance-20261012.md) for test commands, calendar assumptions and scope limits.

The PR #51 follow-up reran authenticated application acceptance after correcting
published pagination and monotonic source revision fencing. `historyBoundary`
records a real native datafeed request for 5000 bars: all 4002 frozen bars are
returned and `noData=true` ends pagination. `staleSnapshot` records a deliberately
injected older revision through the real browser message handler: the display
retains its snapshot and no native plot callback runs. Ordinary shared SSE
withdrawal/restoration/confirmation is separately exercised against the worker.
The two-chart screenshot is taken after both charts finish loading and consume
the restored SSE result.
