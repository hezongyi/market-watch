# Preserve the deployed data-worker baseline (including Dukascopy pool recovery); only replace the fixed-quote reader.
# Required local base: sha256:37320e89fa8df3195814317ba337458b589a17e86c4cf2770817559874e848af
FROM market-watch-api:dukascopy-history-pool-20261117
COPY backend/alerts/quote_presentation.py /app/backend/alerts/quote_presentation.py
COPY backend/alerts/quote_presentation.py /usr/local/lib/python3.11/site-packages/alerts/quote_presentation.py
