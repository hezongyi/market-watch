# Private build context: history.cpp plus the licensed ForexConnect 1.6.5
# sdk/include and sdk/lib. SDK bytes must never enter the repository.
FROM python:3.11-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY sdk/include /sdk/include
COPY sdk/lib /sdk/lib
COPY history.cpp /src/history.cpp
RUN g++ -std=c++17 -O2 -pthread -I/sdk/include -L/sdk/lib /src/history.cpp -lForexConnect -Wl,-rpath-link,/sdk/lib -o /fxcm-history
FROM scratch
COPY --from=build /fxcm-history /fxcm-history
