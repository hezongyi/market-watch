import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Move existing rows into their new positions; data order and buttons stay native. */
export default function WatchReorderList({ order, children, className }: {
  order: string[]; children: ReactNode; className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const animations = useRef<Animation[]>([]);
  const key = JSON.stringify(order);
  useLayoutEffect(() => {
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
    const next = new Map<string, number>();
    for (const row of root.current?.querySelectorAll<HTMLElement>(":scope > [data-order-id]") || []) {
      const id = row.dataset.orderId!, top = row.offsetTop, previous = positions.current.get(id);
      next.set(id, top);
      if (previous !== undefined && top !== previous && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        animations.current.push(row.animate([
          { transform: `translateY(${previous - top}px)` }, { transform: "translateY(0)" },
        ], { duration: 200, easing: "cubic-bezier(.22,1,.36,1)" }));
      }
    }
    positions.current = next;
    return () => animations.current.forEach(animation => animation.cancel());
  }, [key]);
  return <div ref={root} className={className} data-watch-reorder>{children}</div>;
}
