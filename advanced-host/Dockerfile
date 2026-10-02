FROM node:22-bookworm-slim AS assets
WORKDIR /assets
COPY index.html build-assets.mjs series.js bridge.js indicators.js preferences.js chart-style.js chart-autosave.js workspaces.js watchlists.js range-sync.js viewports.js history-demand.js progressive-history.js chart-account.js chart-menu.js chart-menu.css ./
RUN node build-assets.mjs

FROM nginx:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=assets /assets/ /usr/share/nginx/html/
COPY charting_library/ /usr/share/nginx/html/charting_library/
RUN test -s /usr/share/nginx/html/charting_library/charting_library.js
EXPOSE 80
