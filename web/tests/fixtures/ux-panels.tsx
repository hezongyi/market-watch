import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CalendarView } from "../../src/market-data/CalendarView";
import { CenterContext } from "../../src/market-data/router";
import { ChartAlertDialog } from "../../src/advanced/ChartAlertDialog";
import { freshDraft } from "../../src/advanced/chartAlerts";
import ReplayJobs from "../../src/ReplayJobs";
import "../../src/style.css";
import "../../src/advanced/chart-alerts.css";

function Harness() {
  const [location, setLocation] = useState(
    "/market-data/calendars?query=BTCUSDT",
  );
  const mode = new URLSearchParams(window.location.search).get("mode");
  const initial = freshDraft({
    request_id: "fixture",
    instrument: "XAUUSD",
    series_kind: "managed",
    source: "dukascopy",
    timeframe: "H4",
    price: "99999",
    indicator: {
      name: "MACD",
      version: "1",
      params: { fast: 12, slow: 26, signal: 9 },
      output: "macd",
    },
    association: {
      workspace_id: "fixture",
      chart_id: "fixture",
      generation: "fixture",
      chart_index: 0,
    },
  });
  if (mode === "alert")
    return (
      <ChartAlertDialog
        initial={initial}
        requestId="fixture"
        editing={null}
        theme="light"
        onDraft={(draft) => {
          (window as any).draft = draft;
        }}
        onSaved={() => {}}
        onClose={() => {}}
      />
    );
  if (mode === "replay") {
    const job = {
      instrument_id: "BTCUSDT",
      priority: 10,
      start: 0,
      end: 60000,
      cursor: 60000,
    };
    return (
      <>
        <ReplayJobs
          jobs={[
            { ...job, id: "complete", status: "complete" },
            { ...job, id: "running", status: "running" },
            {
              ...job,
              id: "failed",
              status: "failed",
              error: "fixture failure",
            },
          ]}
          summary={{
            total: 822,
            counts: { complete: 820, running: 1, failed: 1 },
            weekly_requests: [
              {
                id: "week",
                instrument_id: "XAUUSD",
                status: "needs_review",
                before: 0,
                remaining: 10,
              },
            ],
          }}
          retry={(id) => {
            (window as any).retried = id;
          }}
        />
        <p>演练结果与播放控制</p>
      </>
    );
  }
  return (
    <CenterContext.Provider
      value={{
        location,
        navigate: setLocation,
        timezone: "UTC",
        apply: async () => {},
        setDirty: () => {},
        clearDirty: () => {},
        busy: false,
      }}
    >
      <CalendarView />
    </CenterContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
