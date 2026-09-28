import {
  generateUrls,
  normaliseDates,
  processData,
  formatOutput,
} from "dukascopy-node";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
if (
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy
)
  setGlobalDispatcher(new EnvHttpProxyAgent());
const [instrument = "eurusd", mode = "live", from, to] = process.argv.slice(2);
const timeout = setTimeout(() => {
  console.error(JSON.stringify({ error: "provider_timeout", instrument }));
  process.exit(2);
}, 45000);
try {
  const timeframe = mode === "quote" ? "tick" : "m1";
  if (!["eurusd", "xauusd", "btcusd"].includes(instrument))
    throw new Error("Unsupported instrument");
  const end = mode === "history" ? new Date(to) : new Date(),
    start = mode === "history" ? new Date(from) : new Date(+end - (mode === "quote" ? 60_000 : 150 * 60_000));
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || start >= end)
    throw new Error("Invalid date interval");
  const [startDate, endDate] = normaliseDates({
    instrument,
    startDate: start,
    endDate: end,
    timeframe,
    utcOffset: 0,
  });
  const urls = generateUrls({
    instrument,
    timeframe,
    priceType: "bid",
    startDate,
    endDate,
  });
  const buffers = [],
    observed = new Set();
  for (const url of urls) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok)
      throw new Error(
        `Provider HTTP ${response.status}; retry-after=${response.headers.get("retry-after") || "unspecified"}`,
      );
    const buffer = Buffer.from(await response.arrayBuffer()),
      raw = JSON.parse(buffer.toString("utf8"));
    if (!Array.isArray(raw.times))
      throw new Error("Provider returned an invalid candle payload");
    let timestamp = raw.timestamp;
    for (const delta of raw.times) {
      timestamp += delta * (mode === "quote" ? 1 : raw.shift);
      observed.add(timestamp);
    }
    buffers.push({ url, buffer });
    if (url !== urls.at(-1)) await new Promise((r) => setTimeout(r, 1000));
  }
  const decoded = processData({
    instrument,
    requestedTimeframe: timeframe,
    bufferObjects: buffers,
    priceType: "bid",
    volumes: true,
    volumeUnits: "units",
    ignoreFlats: false,
  });
  let selected = decoded.filter(
    (row) => observed.has(row[0]) && row[0] >= +startDate && row[0] < +endDate,
  );
  if (mode === "live") selected = selected.slice(-30);
  const rows = formatOutput({
    processedData: selected,
    format: "json",
    timeframe,
  });
  console.log(
    JSON.stringify({
      instrument,
      source: "dukascopy",
      basis: "bid",
      received_at: new Date().toISOString(),
      window_start: +startDate,
      window_end: +endDate,
      synthetic_minutes_removed:
        decoded.length - decoded.filter((r) => observed.has(r[0])).length,
      rows,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({ error: String(e), cause: e.cause?.code, instrument }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
