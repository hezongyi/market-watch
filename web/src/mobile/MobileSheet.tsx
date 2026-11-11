import { useEffect, useId, useRef, type ReactNode } from "react";
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
  current.current = { dirty, close };
  const leave = () => {
    if (!current.current.dirty || confirm("放弃尚未提交的修改？"))
      current.current.close();
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
      {children}
    </dialog>
  );
}
