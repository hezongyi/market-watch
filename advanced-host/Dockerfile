FROM nginx:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html bridge.js indicators.js preferences.js chart-style.js workspaces.js watchlists.js range-sync.js viewports.js history-demand.js progressive-history.js /usr/share/nginx/html/
COPY charting_library/ /usr/share/nginx/html/charting_library/
RUN test -s /usr/share/nginx/html/charting_library/charting_library.js
EXPOSE 80
