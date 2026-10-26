FROM node:22-bookworm-slim AS build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
COPY advanced-host/ /app/advanced-host/
ARG NATIVE_RESERVE_ENABLED=true
ENV NATIVE_RESERVE_ENABLED=${NATIVE_RESERVE_ENABLED}
RUN npm run build
FROM nginx:1.28-alpine
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY --from=build /app/web/src/app/MAGIC_UI_LICENSE.md /usr/share/nginx/html/MAGIC_UI_LICENSE.md
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
