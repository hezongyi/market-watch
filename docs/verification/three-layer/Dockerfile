# Extend the existing local supplier image without touching its tag/observation.
FROM market-watch-data-integration:dev
USER root
COPY requirements.lock /tmp/three-layer-requirements.lock
RUN pip install --no-cache-dir -r /tmp/three-layer-requirements.lock \
    && rm /tmp/three-layer-requirements.lock
USER app
