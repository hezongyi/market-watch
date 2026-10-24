import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** Browser modal provides focus containment and restores focus on close. */
export function AlertLogCleanup({
  ownerDocument,
  count,
  busy,
  theme,
  onClose,
  onConfirm,
}: {
  ownerDocument: Document;
  count: number;
  busy: boolean;
  theme: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = ownerDocument.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [ownerDocument]);
  return createPortal(
    <dialog
      ref={dialog}
      className="chart-alert-dialog alert-cleanup-dialog"
      data-theme={theme}
      aria-labelledby="alert-cleanup-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="alert-cleanup-title">移除 {count} 条已加载日志？</h2>
      <p>
        仅从默认列表移除，原始事件与证据保留，可通过“显示已清理日志”找回。此操作不停止手机提醒。
      </p>
      <footer>
        <button autoFocus disabled={busy} onClick={onClose}>
          取消
        </button>
        <button disabled={busy} onClick={onConfirm}>
          {busy ? "正在移除…" : "移除"}
        </button>
      </footer>
    </dialog>,
    ownerDocument.body,
  );
}
