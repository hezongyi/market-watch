SELECT candles.id, candles.instrument_id, candles.timeframe, candles.start, candles."end", candles.open, candles.high, candles.low, candles.close, candles.complete, candles.revision, candles.received_at, candles.observed_at, candles.volume, candles.volume_complete, candles.volume_received_at, candles.volume_revision
FROM candles
WHERE candles.instrument_id = 'BENCH000' AND candles.timeframe = 'M1' AND candles.start >= 1791936000000 AND candles.start < 1792022400000 ORDER BY candles.start;
