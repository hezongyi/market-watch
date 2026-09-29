# Pinned drawing tools

Lightweight Charts is pinned to 5.2.1 (Apache-2.0, TradingView). The chart shows
its attribution and links to TradingView. Seven community Line Tools packages
are vendored at the exact commits in `line-tools-sources.json`; individual MPL-2.0
licenses are preserved under `licenses/`. Repository upstream:
https://github.com/difurious/lightweight-charts-line-tools-core (and the other
repository names in the manifest under the same owner).

`line-tools-source.tar.gz` contains the unmodified upstream sources.
`build-line-tools.mjs` (published alongside this notice) applies the Market Watch
calendar guard: return null outside the explicit grid rather than extrapolating
from recent candle spacing. This modification remains under MPL-2.0. Runtime
bundle: `src/charts/vendor/line-tools.js`. No private TradingView Advanced Charts
code or KLineChart Pro runtime is included.

Rebuild after `npm ci` in web: `npm run vendor:build`. This is offline and uses
only the archived sources and lockfile dependencies. A full TypeScript program
emit removes upstream type-only reexports; isolated TS transpilation is unsafe.
Upstream type diagnostics are not release gates; our adapter typecheck, browser
creation/edit/import tests and deterministic artifact checksum are the gates.
The script prints SHA-256 and deletes its temporary build directory.

Before upgrading: run the workspace browser acceptance and test all eight tools,
save/import, future calendar geometry and multi-pane sharing. Do not update the
bundle independently from source archive, calendar guard, license files and commit manifest.

Vite publishes this directory with the app, including the complete upstream source
archive and license notices, so recipients can obtain the corresponding source.
