FROM node:22-bookworm-slim AS alert-ui
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/src ./src
COPY web/scripts/build-alert-ui.mjs ./scripts/build-alert-ui.mjs
RUN node scripts/build-alert-ui.mjs /alert-ui

FROM node:22-bookworm-slim AS assets
WORKDIR /assets
COPY advanced-host/index.html advanced-host/build-assets.mjs advanced-host/patch-native-reserve.mjs advanced-host/native-reserve.js advanced-host/native-navigation.js advanced-host/bar-range-mapping.js advanced-host/series.js advanced-host/drawing-projection.js advanced-host/chart-alerts.js advanced-host/bridge.js advanced-host/indicators.js advanced-host/indicator-picker.js advanced-host/indicator-picker.css advanced-host/preferences.js advanced-host/chart-style.js advanced-host/chart-autosave.js advanced-host/workspaces.js advanced-host/watchlists.js advanced-host/watchlist-layout.js advanced-host/sync-coordinator.js advanced-host/range-sync.js advanced-host/viewports.js advanced-host/history-demand.js advanced-host/progressive-history.js advanced-host/chart-account.js advanced-host/sync-settings.js advanced-host/chart-menu.js advanced-host/chart-menu.css ./
COPY advanced-host/charting_library/ ./charting_library/
COPY advanced-host/chart-maximize.js advanced-host/data-center.js advanced-host/price-format.js ./
COPY advanced-host/chart-theme.js ./
COPY advanced-host/swing-sr-display.js advanced-host/study-templates.js ./
COPY advanced-host/native-ui.js advanced-host/native-indicator-dialog.js ./
COPY advanced-host/patch-native-toolset.mjs ./
COPY advanced-host/native-alert-shell.js ./
COPY advanced-host/chart-notices.js ./
COPY advanced-host/native-indicator-results.js advanced-host/indicator-coordinator.js advanced-host/composite-display-batches.js ./
COPY --from=alert-ui /alert-ui/ ./
ARG NATIVE_RESERVE_ENABLED=true
ENV NATIVE_RESERVE_ENABLED=${NATIVE_RESERVE_ENABLED}
RUN if [ "$NATIVE_RESERVE_ENABLED" = "true" ]; then node patch-native-reserve.mjs; \
    elif [ "$NATIVE_RESERVE_ENABLED" = "false" ]; then node patch-native-reserve.mjs --disable; \
    else exit 1; fi
RUN node patch-native-toolset.mjs && node build-assets.mjs

FROM nginx:1.28-alpine
COPY advanced-host/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=assets /assets/ /usr/share/nginx/html/
RUN test -s /usr/share/nginx/html/charting_library/charting_library.js
EXPOSE 80
