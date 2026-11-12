import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export default function MobileSheet({
  title,
  dirty = false,
  close,
  children,
}: {
  title: string;
  dirty?: boolean;
  close(): void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    label = useId();
  const current = useRef({ dirty, close });
  const [discard, setDiscard] = useState(false);
  current.current = { dirty, close };
  const leave = () => {
    if (current.current.dirty) setDiscard(true);
    else current.current.close();
  };
  useEffect(() => {
    const value = dialog.current!;
    value.showModal();
    const back = (event: Event) => {
      if (
        [...document.querySelectorAll("dialog.mobile-sheet[open]")].at(-1) !==
        value
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      leave();
    };
    addEventListener("mw-mobile-back", back, true);
    return () => {
      removeEventListener("mw-mobile-back", back, true);
      value.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="mobile-sheet"
      aria-labelledby={label}
      data-mobile-dirty={dirty || undefined}
      onCancel={(event) => {
        event.preventDefault();
        leave();
      }}
    >
      <header>
        <h2 id={label}>{title}</h2>
        <button aria-label="关闭" onClick={leave}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="mobile-sheet-body">{children}</div>
      {discard && <MobileSheet title="放弃本次修改？" close={() => setDiscard(false)}>
        <p className="mobile-hint">更改尚未提交。放弃后不会恢复草稿，已保存的数据保持不变。</p>
        <div className="mobile-sheet-actions">
          <button className="primary" onClick={() => setDiscard(false)}>继续编辑</button>
          <button onClick={() => current.current.close()}>放弃修改</button>
        </div>
      </MobileSheet>}
    </dialog>
  );
}
