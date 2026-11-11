import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** Native modal dialogs make outside controls inert; keep feedback inside the top layer. */
export default function MobileToast({
  message,
  close,
}: {
  message: string;
  close(): void;
}) {
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => {
    const observe = () =>
      setTarget(
        [...document.querySelectorAll("dialog.mobile-sheet[open]")].at(-1) ||
          null,
      );
    observe();
    const observer = new MutationObserver(observe);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, []);
  if (!message) return null;
  const toast = (
    <aside className="mobile-toast" role="alert">
      <span>{message}</span>
      <button aria-label="关闭通知" onClick={close}>
        关闭
      </button>
    </aside>
  );
  return target ? createPortal(toast, target) : toast;
}
