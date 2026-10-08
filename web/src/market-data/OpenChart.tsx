import { useState } from "react";
import { useCenter } from "./router";

export function OpenChart({ ticker, frame = "M1", label = "在当前图表打开" }: { ticker: string; frame?: string; label?: string }) {
  const { apply, busy } = useCenter();
  const [error, setError] = useState("");
  return <><button disabled={busy} onClick={() => { setError(""); void apply(ticker, frame).catch(e => setError(String(e))); }}>{busy ? "正在打开…" : label}</button>{error && <span className="error" role="alert">{error}</span>}</>;
}
