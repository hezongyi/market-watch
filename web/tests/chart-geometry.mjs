// Exercise the shipped plugin geometry with explicit calendar grids.
import assert from "node:assert/strict";
import {
  interpolateTimeFromLogicalIndex as toTime,
  interpolateLogicalIndexFromTime as toIndex,
} from "../src/charts/vendor/line-tools.js";
const sec = (s) => Date.parse(s) / 1000;
function adapters(times) {
  const ts = {
    timeToCoordinate(t) {
      let i = times.indexOf(Number(t));
      return i < 0 ? null : i * 10;
    },
    coordinateToLogical: (x) => x / 10,
    logicalToCoordinate: (x) => x * 10,
  };
  return [
    { timeScale: () => ts },
    {
      dataByIndex(i, d) {
        const index =
          d === 1
            ? Math.max(0, Math.ceil(i))
            : d === -1
              ? Math.min(times.length - 1, Math.floor(i))
              : i;
        return times[index] === undefined ? undefined : { time: times[index] };
      },
    },
  ];
}
for (const times of [
  ["2026-03-06T21:00Z", "2026-03-08T22:05Z", "2026-03-08T22:10Z"].map(sec),
  [
    "2024-01-31T22:00Z",
    "2024-02-29T22:00Z",
    "2024-03-31T21:00Z",
    "2024-04-30T21:00Z",
  ].map(sec),
  ["2026-09-28T20:55Z", "2026-09-28T22:05Z", "2026-09-28T22:10Z"].map(sec),
]) {
  const [c, s] = adapters(times);
  for (let i = 0; i < times.length; i++) {
    assert.equal(toTime(c, s, i), times[i]);
    assert.equal(toIndex(c, s, times[i]), i);
  }
  const midway = (times[0] + times[1]) / 2;
  assert.equal(toTime(c, s, 0.5), midway);
  assert.equal(toIndex(c, s, midway), 0.5);
  assert.equal(toTime(c, s, -1), null);
  assert.equal(toTime(c, s, times.length), null);
  assert.equal(toIndex(c, s, times.at(-1) + 3600), null);
  const [c2, s2] = adapters([times[0] - 86400, ...times]);
  assert.equal(toIndex(c2, s2, times[1]), 2);
}
console.log(
  "Calendar geometry: DST, weekend, maintenance, natural months, history prepend and projection bounds PASS",
);
