FROM node:22-bookworm-slim AS adapter
WORKDIR /adapter
COPY adapters/dukascopy/package*.json ./
RUN npm ci --omit=dev
COPY adapters/dukascopy/probe.mjs ./

FROM python:3.11-slim-bookworm
COPY --from=adapter /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY pyproject.toml requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY backend ./backend
COPY migrations ./migrations
COPY alembic.ini ./
COPY scripts/volume_backfill.py ./scripts/volume_backfill.py
COPY scripts/oanda_live_sessions.py ./scripts/oanda_live_sessions.py
RUN pip install --no-cache-dir --no-deps .
COPY --from=adapter /adapter ./adapters/dukascopy
RUN useradd --uid 10001 --create-home app
USER app
EXPOSE 8000
CMD ["uvicorn", "alerts.api:app", "--host", "0.0.0.0", "--port", "8000"]
