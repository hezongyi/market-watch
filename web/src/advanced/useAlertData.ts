import { useCallback, useEffect, useRef, useState } from "react";
import type { AlertApi } from "./chartAlertUiApi";
import type { AlertEvent, AlertRow } from "./chartAlerts";
import { errorMessage } from "../api";

function older(a: AlertRow, b: AlertRow) {
  return (
    a.control_revision < b.control_revision ||
    a.version < b.version ||
    (a.control_revision === b.control_revision &&
      a.version === b.version &&
      (a.run < b.run ||
        (a.run === b.run &&
          (a.count < b.count || a.updated_at < b.updated_at))))
  );
}
/** Each mount owns its requests. Mutations fence reads and never wait for events. */
export function useAlertData(
  request: AlertApi,
  onRows: (rows: AlertRow[]) => void,
) {
  const [rows, setRows] = useState<AlertRow[]>([]),
    [events, setEvents] = useState<AlertEvent[]>([]);
  const [error, setError] = useState("");
  const failures = useRef({ lists: "", events: "" });
  const refs = useRef({ request, onRows });
  refs.current = { request, onRows };
  const state = useRef({
    active: true,
    generation: 0,
    fence: 0,
    rows: [] as AlertRow[],
    barriers: new Map<string, AlertRow>(),
    removed: new Set<string>(),
    lists: { running: false, dirty: false },
    events: { running: false, dirty: false },
  });
  useEffect(() => {
    const s = state.current;
    s.active = true;
    return () => {
      s.active = false;
      s.generation++;
      s.lists = { running: false, dirty: false };
      s.events = { running: false, dirty: false };
    };
  }, []);
  const publish = useCallback((next: AlertRow[]) => {
    const s = state.current;
    if (!s.active) return;
    s.rows = next;
    setRows(next);
    refs.current.onRows(next);
  }, []);
  const commit = useCallback(
    (row: AlertRow) => {
      const s = state.current;
      if (!s.active) return;
      const previous =
        s.barriers.get(row.id) || s.rows.find((item) => item.id === row.id);
      if (s.removed.has(row.id) || (previous && older(row, previous))) return;
      s.fence++;
      if (row.status === "archived") {
        s.removed.add(row.id);
        s.barriers.delete(row.id);
      } else s.barriers.set(row.id, row);
      publish([
        ...s.rows.filter((item) => item.id !== row.id),
        ...(row.status === "archived" ? [] : [row]),
      ]);
    },
    [publish],
  );
  const refresh = useCallback(async () => {
    const s = state.current,
      generation = s.generation;
    const current = () => s.active && s.generation === generation;
    async function read(kind: "lists" | "events") {
      const flight = s[kind];
      if (flight.running) {
        flight.dirty = true;
        return;
      }
      flight.running = true;
      try {
        do {
          flight.dirty = false;
          const fence = s.fence;
          try {
            if (kind === "events") {
              const next = await refs.current.request<AlertEvent[]>(
                "/chart-alerts/events",
              );
              if (current()) setEvents(next);
            } else {
              const next =
                await refs.current.request<AlertRow[]>("/chart-alerts");
              if (!current()) return;
              if (fence !== s.fence) {
                flight.dirty = true;
                continue;
              }
              const previous = new Map(s.rows.map((row) => [row.id, row]));
              const merged = new Map<string, AlertRow>();
              for (const row of next) {
                if (s.removed.has(row.id) || row.status === "archived")
                  continue;
                const old = previous.get(row.id);
                merged.set(row.id, old && older(row, old) ? old : row);
              }
              for (const [id, barrier] of s.barriers) {
                const observed = merged.get(id);
                if (!observed || older(observed, barrier))
                  merged.set(id, barrier);
                else s.barriers.delete(id);
              }
              publish([...merged.values()]);
            }
            if (current()) {
              failures.current[kind] = "";
              setError(failures.current.lists || failures.current.events);
            }
          } catch (e) {
            if (current()) {
              failures.current[kind] = errorMessage(e);
              setError(failures.current.lists || failures.current.events);
            }
          }
        } while (current() && flight.dirty);
      } finally {
        flight.running = false;
      }
    }
    await Promise.all([read("lists"), read("events")]);
  }, [publish]);
  return { rows, events, error, setError, refresh, commit };
}
