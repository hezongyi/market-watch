import { useState } from "react";
import type { Instrument } from "./api";
import { instrumentIdentity } from "./instrumentPresentation";

export default function InstrumentDetails({
  instrument,
}: {
  instrument: Instrument;
}) {
  const [message, setMessage] = useState("");
  return (
    <details className="instrument-details">
      <summary>行情身份与内部标识</summary>
      <p>{instrumentIdentity(instrument)}</p>
      <p>
        来源代码：
        {instrument.dataset_identity?.provider_symbol ||
          instrument.symbol ||
          "未提供"}
      </p>
      {instrument.dataset_identity && (
        <p>
          账户范围：{instrument.dataset_identity.account_scope} · 日历版本：
          {instrument.dataset_identity.calendar_version}
        </p>
      )}
      <p>
        内部标识：<code>{instrument.id}</code>
      </p>
      <button
        type="button"
        className="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(instrument.id);
            setMessage("内部标识已复制");
          } catch {
            setMessage("无法自动复制，请选中上方内部标识复制。");
          }
        }}
      >
        复制内部标识
      </button>
      <span role="status">{message}</span>
    </details>
  );
}
