FROM node:22-bookworm-slim AS build
WORKDIR /web
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_ADVANCED_CHART_ORIGIN
ENV VITE_ADVANCED_CHART_ORIGIN=${VITE_ADVANCED_CHART_ORIGIN}
RUN npm run build
FROM nginx:1.28-alpine
COPY --from=build /web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
