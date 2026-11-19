FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libfreetype6 libfontconfig1 libz1 && rm -rf /var/lib/apt/lists/*
# JDK, Android SDK and Gradle are mounted read-only from existing local tools.
