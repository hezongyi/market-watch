import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// One detail surface per document; switching rows never restores the old trigger.
export function useDetailPanel() {
  const id = useId();
  const [opened, setOpened] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const switchPanel = (event: Event) => {
      if ((event as CustomEvent).detail !== id) setOpened(false);
    };
    window.addEventListener("dc-detail-open", switchPanel);
    return () => window.removeEventListener("dc-detail-open", switchPanel);
  }, [id]);
  return {
    opened,
    open: useCallback(() => {
      trigger.current = document.activeElement as HTMLElement;
      window.dispatchEvent(new CustomEvent("dc-detail-open", { detail: id }));
      setOpened(true);
    }, [id]),
    close: useCallback(() => {
      setOpened(false);
      const previous = trigger.current;
      requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus({ preventScroll: true });
      });
    }, []),
  };
}

/** Uses the current chart dialog's content area and theme, without another modal. */
export function DetailPanel({
  title,
  close,
  children,
}: {
  title: ReactNode;
  close: () => void;
  children: ReactNode;
}) {
  const label = useId(),
    panel = useRef<HTMLElement>(null);
  const target = document.querySelector(".dc-window-content");
  useEffect(() => {
    const hidden = new Map<HTMLElement, boolean>();
    const fit = () => {
      if (!target || !panel.current) return;
      const box = { width: target.clientWidth, height: target.clientHeight };
      const full = box.width < 900;
      target.setAttribute("data-detail-mode", full ? "full" : "side");
      for (const child of Array.from(target.children)) {
        if (!(child instanceof HTMLElement) || child === panel.current)
          continue;
        if (!hidden.has(child)) hidden.set(child, child.inert);
        child.inert = full || hidden.get(child)!;
      }
      Object.assign(panel.current.style, {
        top: `${target.scrollTop}px`,
        right: "0px",
        width: full ? `${box.width}px` : "360px",
        height: `${box.height}px`,
        maxWidth: `${box.width}px`,
      });
    };
    fit();
    panel.current?.focus({ preventScroll: true });
    const resize = new ResizeObserver(fit);
    if (target) resize.observe(target);
    window.addEventListener("resize", fit);
    target?.addEventListener("scroll", fit);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", fit);
      target?.removeEventListener("scroll", fit);
      target?.removeAttribute("data-detail-mode");
      for (const [node, previous] of hidden) node.inert = previous;
    };
  }, [target]);
  if (!target)
    return (
      <section className="dc-detail-inline">
        <h3>{title}</h3>
        {children}
        <button type="button" onClick={close}>
          返回
        </button>
      </section>
    );
  return createPortal(
    <aside
      ref={panel}
      className="dc-detail-panel"
      role="region"
      aria-labelledby={label}
      tabIndex={-1}
    >
      <div className="dc-detail-header">
        <h2 id={label}>{title}</h2>
        <button
          type="button"
          data-dc-detail-close
          aria-label="关闭详情"
          onClick={close}
        >
          返回列表
        </button>
      </div>
      <div className="dc-detail-body">{children}</div>
    </aside>,
    target,
  );
}

/** Read-only disclosures share the same surface instead of expanding table rows. */
export function DetailDisclosure({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const detail = useDetailPanel();
  return (
    <>
      <button
        type="button"
        className={className || "dc-detail-trigger"}
        onClick={detail.open}
        aria-expanded={detail.opened}
      >
        {title}
      </button>
      {detail.opened && (
        <DetailPanel title={title} close={detail.close}>
          {children}
        </DetailPanel>
      )}
    </>
  );
}
