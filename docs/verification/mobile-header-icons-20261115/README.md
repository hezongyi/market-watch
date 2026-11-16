# Mobile header icons verification

- Watch add, Data add and alert creation use plus; Data and alert rules use search. Alert records retain their inline search.
- Shared page and drawer actions use transparent 44 px targets, 22 px Lucide icons, 4 px spacing and a marker for effective search conditions. Enhanced search uses ListFilter.
- Built the mobile shell and exercised Watch, Data creation/maintenance/live workflow and categories, symbol search, Alerts, More, and app back/dirty flows using browser fixtures. Screenshots cover 375/412 px, light/dark and 14/21 px text. Shared geometry is checked against computed styles; keyboard focus, press stability and reduced motion are exercised on the add, filter and close actions.
- Updated only the web service of the Ubuntu Docker project `mw-managed-live-rollover-20261113`. Trusted TLS, shell files, readiness, readonly APK mount, manifest and APK checksum passed. A browser using an isolated profile checked navigation and drawers against the deployed instance, with page API writes blocked; it does not replace Android device acceptance.
- Acceptance: `https://192.168.7.232:18447/m/`. Start: `/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh`. Stop: `/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh`.
