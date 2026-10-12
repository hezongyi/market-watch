import { useState } from "react";
import { useCenter, useActionLock, useMounted } from "./router";

export function OpenChart({ ticker, frame = "M1", label = "在当前图表打开" }: { ticker: string; frame?: string; label?: string }) {
  const { apply, busy } = useCenter();
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const lock = useActionLock(), mounted = useMounted();
  async function open() {
    if (busy || !lock.acquire()) return;
    setError(""); setOpening(true);
    try { await apply(ticker, frame); }
    catch (e) { if (mounted.current) setError(String(e)); }
    finally { lock.release(); if (mounted.current) setOpening(false); }
  }
  return <><button aria-disabled={busy} aria-busy={opening || undefined} title="打开将关闭品种和周期同步，保留其他图格。" onClick={() => void open()}>{opening ? "正在打开…" : label}</button>{error && <span className="error" role="alert">{error}</span>}</>;
}
