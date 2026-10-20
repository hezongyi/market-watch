import { useEffect, useId, useState } from "react";
import { AlertInput, AlertButton } from "../advanced/NativeAlertControls";
import { dateTimeInput, offsetLabel, wallTimeCandidates } from "./chartTime";

type Props = {
  value: number | null;
  zone: string;
  label: string;
  onChange: (value: number | null) => void;
  onValidityChange: (valid: boolean) => void;
};
/** Keep the instant when the display zone changes; newly typed walls use the current zone. */
export function ZonedDateTimeInput({
  value,
  zone,
  label,
  onChange,
  onValidityChange,
}: Props) {
  const id = useId();
  const [text, setText] = useState(() => dateTimeInput(value, zone));
  const [choice, setChoice] = useState<number | null>(value);
  useEffect(() => {
    setText(dateTimeInput(value, zone));
    setChoice(value);
    onValidityChange(true);
  }, [value, zone]);
  const candidates = text ? wallTimeCandidates(text, zone) : [];
  const ambiguous = candidates.length > 1;
  const valid =
    !text ||
    candidates.length === 1 ||
    (choice != null && candidates.includes(choice));
  const error =
    !text || valid
      ? ""
      : ambiguous
        ? "该时间因夏令时结束出现两次，请选择实际时刻。"
        : "该时间无效或因夏令时跳跃而不存在，请修改。";
  return (
    <span className="zoned-time-input">
      <AlertInput
        type="datetime-local"
        step="0.001"
        aria-label={label}
        value={text}
        aria-invalid={!valid}
        aria-describedby={error ? id : undefined}
        onChange={(event) => {
          const next = event.target.value,
            options = next ? wallTimeCandidates(next, zone) : [];
          const ok = !next || options.length === 1;
          setText(next);
          setChoice(null);
          onValidityChange(ok);
          if (ok) onChange(options[0] ?? null);
        }}
      />
      <small className="zoned-time-hint">
        {candidates.length === 1 || (valid && choice != null)
          ? `按 ${offsetLabel(choice ?? candidates[0], zone)} 输入`
          : ambiguous
            ? "请选择下方实际 UTC 偏移"
            : `跟随激活图表${text ? "，请修正时间" : `（当前 ${offsetLabel(Date.now(), zone)}）`}`}
      </small>
      {ambiguous && (
        <span
          className="zoned-time-choices"
          role="group"
          aria-label={`${label}重复时刻`}
        >
          {candidates.map((stamp, index) => (
            <AlertButton
              key={stamp}
              primary={choice === stamp}
              onClick={() => {
                setChoice(stamp);
                onValidityChange(true);
                onChange(stamp);
              }}
            >
              {`${choice === stamp ? "已选 · " : ""}第 ${index + 1} 次 · ${offsetLabel(stamp, zone)}`}
            </AlertButton>
          ))}
        </span>
      )}
      {error && (
        <span id={id} className="zoned-time-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
