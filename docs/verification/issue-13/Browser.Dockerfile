FROM scratch
# Export the existing pinned Ubuntu-local node:22-bookworm-slim container rootfs
# into a private build context; avoids registry resolution by separate BuildKit.
ADD node-rootfs.tar /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdbus-1-3 libxkbcommon0 libasound2 libgbm1 libcairo2 libpango-1.0-0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libatspi2.0-0 \
    libdrm2 libx11-6 libxext6 libxcb1 libexpat1 libudev1 fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
