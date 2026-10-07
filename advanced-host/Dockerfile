FROM node:22-bookworm-slim AS assets
WORKDIR /assets
COPY index.html build-assets.mjs patch-native-reserve.mjs native-reserve.js native-navigation.js bar-range-mapping.js series.js drawing-projection.js chart-alerts.js bridge.js indicators.js indicator-picker.js indicator-picker.css preferences.js chart-style.js chart-autosave.js workspaces.js watchlists.js sync-coordinator.js range-sync.js viewports.js history-demand.js progressive-history.js chart-account.js sync-settings.js chart-menu.js chart-menu.css ./
COPY charting_library/ ./charting_library/
COPY chart-maximize.js ./
ARG NATIVE_RESERVE_ENABLED=true
ENV NATIVE_RESERVE_ENABLED=${NATIVE_RESERVE_ENABLED}
RUN if [ "$NATIVE_RESERVE_ENABLED" = "true" ]; then node patch-native-reserve.mjs; \
    elif [ "$NATIVE_RESERVE_ENABLED" = "false" ]; then node patch-native-reserve.mjs --disable; \
    else exit 1; fi
RUN node build-assets.mjs

FROM nginx:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=assets /assets/ /usr/share/nginx/html/
RUN test -s /usr/share/nginx/html/charting_library/charting_library.js
EXPOSE 80
